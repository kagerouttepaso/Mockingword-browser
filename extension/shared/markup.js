// 段落の目印の文法。段落のトークン列をモデルに渡す1行にし（encode）、訳文をトークンの木に戻す（decode）。
// DOM にも chrome にも触れない純粋な関数だけを置く（Node の単体試験 tools/unit.test.mjs で確かめる）。
// 目印の文法はここだけに書く。DOM を読む側（page/paragraph.js）と書く側（page/write.js）はこの形を介してつながる
// （docs/11_設計方針.md「段落のデータの流れ」）。
//
// トークン（page/paragraph.js が作る）：
//   { type: 'text', text }               訳す文字
//   { type: 'space' }                    要素の間の空白
//   { type: 'open', id } / { type: 'close', id }   訳した文字を入れ直す入れ物（リンク・飾り）
//   { type: 'code', id, text }           訳さず元のまま写す要素。text はモデルに文脈として見せる
//   { type: 'void', id, br }             文字の無い要素（<br>・アイコン・画像）
// 目印：入れ物 <a1>…</a1>、写す要素 <c1>…</c1>、文字の無い要素 <v1/>。番号は段落の中の要素の番号（id）。

/** 目印1つ（開き・閉じ・空要素）。訳文・原文から目印を取り除くときに使う。 */
export const MARK_TAG = /<\/?[acv]\d+\/?>/g;

/** 訳文の中の目印。写す要素は中身ごと1つとして読む（モデルが中身を書き換えても、元の要素を写す）。 */
const TOKEN = /<c(\d+)>[\s\S]*?<\/c\1>|<(\/?)([av])(\d+)\/?>/g;

const normalize = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * 訳す文字がすべて入れ物の目印の中にある行なら、入れ物の中身（ラベル）の並びを返す。地の文があれば null。コードの中身は数えない。
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
 * 文の途中の <br>（語か読点の後で、小文字から続く）か。手で折り返しただけの見た目の改行なので、目印にせず空白にする。
 * 目印にすると、語順の変わる訳文では文末へ移り「…してください<br>。」となった（2026-11-16、0.8B）。
 */
function softBreak(tokens, i) {
  if (!tokens[i].br) return false;
  const before = neighborText(tokens, i, -1);
  const after = neighborText(tokens, i, 1);
  return !!before && !!after && /[\p{L}\p{N},)]\s*$/u.test(before) && /^\s*\p{Ll}/u.test(after);
}

/**
 * トークン列をモデルに渡す1行にする。返す text は目印付きの1行、plain は訳す文字（写す要素の中身を除く。訳す価値の判定用）。
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
  // 目印の内側の端の空白は外へ出す（<a1> foo </a1> → " <a1>foo</a1> "）。
  text = normalize(text.replace(/\s+/g, ' ').replace(/<(a\d+)> /g, ' <$1>').replace(/ <\/(a\d+)>/g, '</$1> '));
  return { text, plain: normalize(plain) };
}

/**
 * 訳文をトークンの木に戻す。kinds は要素の番号→種類（'a'・'c'・'v'）。
 * 返す木：{ type: 'text', text } | { type: 'wrap', id, children } | { type: 'code', id } | { type: 'void', id }。
 * 崩れた目印は捨てて文字を残す。番号や種類の合わない目印は無視し、閉じずに終わった・外側より先に閉じられなかった入れ物は外す
 * （文の残りが太字・リンクになるのを防ぐ。2026-11-16、目印8組の文で1組の閉じが落ちた）。文字は文字のまま返し、HTML として解釈しない。
 */
export function decode(translation, kinds) {
  const top = { children: [] };
  const stack = [{ node: top, id: 0 }];
  const add = (node) => stack.at(-1).node.children.push(node);
  const text = (s) => {
    const t = s.replace(MARK_TAG, '');
    if (t) add({ type: 'text', text: t });
  };
  /** 閉じられなかった入れ物を外し、中身を親へ移す（深い方から）。 */
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
