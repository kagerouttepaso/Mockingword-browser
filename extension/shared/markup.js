// 段落のマーカーの文法。段落のトークン列をモデルに渡す1行にし（encode）、訳文をトークンの木に戻す（decode）。
// DOM にも chrome にも触れない純粋な関数だけを置く（Node の単体試験 tools/unit.test.mjs で確かめる）。
// マーカーの文法はここだけに書く。DOM を読む側（page/paragraph.js）と書く側（page/write.js）はこの形を介してつながる
// （docs/11_設計方針.md「段落のデータの流れ」）。
//
// トークン（page/paragraph.js が作る）：
//   { type: 'text', text }               訳す文字
//   { type: 'space' }                    要素の間の空白
//   { type: 'open', id } / { type: 'close', id }   訳した文字を入れ直す要素（リンク・飾り）
//   { type: 'code', id, text }           訳さず元のまま写す要素。text はモデルに文脈として見せる
//   { type: 'void', id, br }             文字の無い要素（<br>・アイコン・画像）
// マーカー：要素 <a1>…</a1>、写す要素 <c1>…</c1>、文字の無い要素 <v1/>。番号は段落の中の要素の番号（id）。

import { sentenceEnds } from './sentences.js';

/** マーカー1つ（開き・閉じ・空要素）。訳文・原文からマーカーを取り除くときに使う。 */
export const MARK_TAG = /<(\/?)([acv])(\d+)\/?>/g;

/** 訳文の中のマーカー。写す要素は中身ごと1つとして読む（モデルが中身を書き換えても、元の要素を写す）。 */
const TOKEN = /<c(\d+)>[\s\S]*?<\/c\1>|<(\/?)([av])(\d+)\/?>/g;

const normalize = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * 訳す文字がすべて要素のマーカーの中にある行なら、要素の中身（ラベル）の並びを返す。地の文があれば null。コードの中身は数えない。
 * 例：「<a1><c2>Navigator.bluetooth</c2></a1> <a3>Read only</a3> <a4>Secure context</a4>」→ ['Read only', 'Secure context']。
 */
export function labelsOf(text) {
  const rest = text.replace(/<c(\d+)>[\s\S]*?<\/c\1>/g, ' ');
  const labels = [...rest.matchAll(/<a(\d+)>([\s\S]*?)<\/a\1>/g)].map((m) => normalize(m[2].replace(MARK_TAG, ''))).filter((s) => /\p{L}/u.test(s));
  const outside = rest.replace(/<a(\d+)>[\s\S]*?<\/a\1>/g, ' ').replace(MARK_TAG, '');
  return labels.length && !/\p{L}/u.test(outside) ? labels : null;
}

/** 前後の文字のトークン（空白を飛ばす）。 */
function neighborText(tokens, i, step) {
  for (let j = i + step; j >= 0 && j < tokens.length; j += step) {
    const tk = tokens[j];
    if (tk.type === 'text') return tk.text;
    if (tk.type !== 'space') return null;
  }
  return null;
}

/**
 * 文の途中の <br>（語か読点の後で、小文字から続く）か。手で折り返しただけの見た目の改行なので、マーカーにせず空白にする。
 * マーカーにすると、語順の変わる訳文では文末へ移り「…してください<br>。」となった（2026-11-16、0.8B）。
 */
function softBreak(tokens, i) {
  if (!tokens[i].br) return false;
  const before = neighborText(tokens, i, -1);
  const after = neighborText(tokens, i, 1);
  return !!before && !!after && /[\p{L}\p{N},)]\s*$/u.test(before) && /^\s*\p{Ll}/u.test(after);
}

/**
 * トークン列をモデルに渡す1行にする。返す text はマーカー付きの1行、plain は訳す文字（写す要素の中身を除く。訳す価値の判定用）。
 */
export function encode(tokens) {
  let text = '';
  let plain = '';
  tokens.forEach((tk, i) => {
    switch (tk.type) {
      case 'text': text += tk.text; plain += tk.text; break;
      case 'space': text += ' '; break;
      case 'open': text += `<a${tk.id}>`; break;
      case 'close': text += `</a${tk.id}>`; break;
      case 'code': text += `<c${tk.id}>${normalize(tk.text)}</c${tk.id}>`; break;
      case 'void': text += softBreak(tokens, i) ? ' ' : `<v${tk.id}/>`; break;
    }
  });
  // マーカーの内側の端の空白は外へ出す（<a1> foo </a1> → " <a1>foo</a1> "）。
  text = normalize(text.replace(/\s+/g, ' ').replace(/<(a\d+)> /g, ' <$1>').replace(/ <\/(a\d+)>/g, '</$1> '));
  return { text, plain: normalize(plain) };
}

/**
 * 訳文をトークンの木に戻す。kinds は要素の番号→種類（'a'・'c'・'v'）。
 * 返す木：{ type: 'text', text } | { type: 'wrap', id, children } | { type: 'code', id } | { type: 'void', id }。
 * 崩れたマーカーは捨てて文字を残す。番号や種類の合わないマーカーは無視し、閉じずに終わった・外側より先に閉じられなかった要素は外す
 * （文の残りが太字・リンクになるのを防ぐ。2026-11-16、マーカー8組の文で1組の閉じが落ちた）。文字は文字のまま返し、HTML として解釈しない。
 */
export function decode(translation, kinds) {
  const top = { children: [] };
  const stack = [{ node: top, id: 0 }];
  const add = (node) => stack.at(-1).node.children.push(node);
  const text = (s) => {
    const t = s.replace(MARK_TAG, '');
    if (t) add({ type: 'text', text: t });
  };
  /** 閉じられなかった要素を外し、中身を親へ移す（深い方から）。 */
  const unwrapFrom = (i) => {
    for (let j = stack.length - 1; j >= i; j--) {
      const { node } = stack[j];
      const parent = stack[j - 1].node.children;
      parent.splice(parent.indexOf(node), 1, ...node.children);
    }
    stack.length = i;
  };
  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m; (m = TOKEN.exec(translation)); ) {
    text(translation.slice(last, m.index));
    last = TOKEN.lastIndex;
    const id = Number(m[1] ?? m[4]);
    const kind = m[1] ? 'c' : m[3];
    if (kinds[id - 1] !== kind) {
      if (m[1]) text(m[0]); // 番号の合わない写す要素は、中の文字だけを残す
      continue;
    }
    if (kind === 'c') add({ type: 'code', id });
    else if (kind === 'v') add({ type: 'void', id });
    else if (!m[2]) {
      const node = { type: 'wrap', id, children: [] };
      add(node);
      stack.push({ node, id });
    } else {
      const i = stack.findLastIndex((x) => x.id === id);
      if (i > 0) {
        unwrapFrom(i + 1);
        stack.length = i;
      }
    }
  }
  text(translation.slice(last));
  unwrapFrom(1);
  return top.children;
}

/** 生成中の1行から、表示できるマーカー付き文字列を返す。書きかけの行は文末までに切る。 */
export function previewLine(line, complete = false) {
  let prose = '';
  let cursor = 0;
  const offsets = [];
  const append = (end) => {
    prose += line.slice(cursor, end);
    for (; cursor < end; cursor++) offsets.push(cursor + 1);
  };
  for (const match of line.matchAll(MARK_TAG)) {
    if (match.index < cursor) continue;
    append(match.index);
    const [, closing, kind, id] = match;
    cursor += match[0].length;
    if (!closing && kind === 'c') {
      const close = '</c' + id + '>';
      const end = line.indexOf(close, cursor);
      if (end === -1) return finish(match.index);
      cursor = end + close.length;
      prose += '\uFFFC';
      offsets.push(cursor);
    } else if (closing && offsets.at(-1) === match.index) {
      offsets[offsets.length - 1] = cursor;
    }
  }
  // 生成の末尾がマーカーの途中なら、次の更新で閉じるまで除く。
  const unfinished = /<\/?(?:[acv]\d*\/?)?$/.exec(line);
  const safeEnd = unfinished && unfinished.index >= cursor ? unfinished.index : line.length;
  append(safeEnd);
  return finish(safeEnd);

  function finish(safeEnd) {
    if (complete) return { text: line.slice(0, safeEnd).trim() };
    const ends = sentenceEnds(prose);
    return { text: ends.length ? line.slice(0, offsets[ends.at(-1) - 1]).trim() : '', sentences: ends.length };
  }
}

/** 原文の木から先頭の指定数の文を除く。文の境界をまたぐ要素は残りの文字を包む。 */
export function remainingSource(text, kinds, sentences) {
  const tree = decode(text, kinds);
  const prose = (nodes) => nodes.map((node) => {
    if (node.type === 'text') return node.text;
    if (node.type === 'wrap') return prose(node.children);
    return '\uFFFC';
  }).join('');
  const plain = prose(tree);
  const ends = sentenceEnds(plain);
  // 原文の文末が見つからないときは全文を残す。訳文が原文より多くの文に分かれたときは、既知の最後の文まで除く。
  let skip = ends[Math.min(sentences, ends.length) - 1] ?? 0;
  while (skip && /\s/u.test(plain[skip] ?? '')) skip++;
  function clip(nodes) {
    const tail = [];
    for (const node of nodes) {
      if (!skip) tail.push(node);
      else if (node.type === 'wrap') {
        const children = clip(node.children);
        if (children.length) tail.push({ ...node, children });
      } else if (node.type === 'text') {
        const rest = node.text.slice(skip);
        skip = Math.max(0, skip - node.text.length);
        if (rest) tail.push({ ...node, text: rest });
      } else skip--;
    }
    return tail;
  }
  return clip(tree);
}
