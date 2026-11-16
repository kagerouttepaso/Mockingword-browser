// 段落を読む。段落（ブロックの中の一続きの文字）の DOM を、マーカーの文法（shared/markup.js）のトークン列にし、
// 訳文表示で隠す要素と、訳文を置く場所を決める。段落の中の要素の分類はここの roleOf だけで行う
// （docs/11_設計方針.md「段落のデータの流れ」。要素の種類ごとの例外をほかの場所に足さない）。

import { encode } from '../shared/markup.js';
import { UI, isInline, isInlineCode, skipElement } from './dom.js';

const isLink = (el) => el.tagName === 'A' && el.hasAttribute('href');

/** 要素をマーカーにするかを決める見た目の性質。 */
const LOOK = ['fontWeight', 'fontStyle', 'fontFamily', 'fontSize', 'color', 'backgroundColor', 'textDecorationLine', 'verticalAlign', 'textTransform', 'borderTopStyle', 'borderBottomStyle', 'paddingLeft'];
const lookCache = new WeakMap();
function lookOf(el) {
  let v = lookCache.get(el);
  if (v === undefined) {
    const cs = getComputedStyle(el);
    lookCache.set(el, (v = LOOK.map((k) => cs[k])));
  }
  return v;
}

/** 親と見た目が同じ要素か（背景が透明なら親の背景のまま）。 */
function sameLook(el, parent) {
  const a = lookOf(el);
  const b = lookOf(parent);
  return LOOK.every((k, i) => a[i] === b[i] || (k === 'backgroundColor' && a[i] === 'rgba(0, 0, 0, 0)'));
}

/** 文字の無い要素（アイコン・画像など）が見えているか。<br> は大きさが無くても行を区切る。 */
function visibleVoid(el) {
  if (el.tagName === 'BR') return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * 段落の中の要素の役割。段落の中の要素は種類を名指しせず、この1つの規則で分ける。
 * - 'wrap'：段落の文字を含む要素のうち、リンクと、親と見た目が違うもの（太字・斜体・色・背景や枠のあるバッジなど）。
 *   訳した文字を元の要素のコピーに入れ直す。
 * - 'pass'：段落の文字を含み、親と見た目が同じ要素（React などが文を細かく包む span）。マーカーにせず中へ入る。
 * - 'code'：インラインコード・translate="no" など訳さない要素と、この段落の文字を含むが訳す文字を含まない要素
 *   （中がコードだけのリンクなど）。元のまま中身ごと写す。要素と中のコードを別々のマーカーにすると、モデルが毎回両方を写し、
 *   出力が増えた（2026-11-16、MDN の Navigator のページで出力トークン +21%）。
 * - 'void'：文字の無い、見える要素（<br>・アイコン・画像）。元のまま写す。
 * - 'foreign'：入れ子のブロック・inline-block（ボタンなど。別の段落として訳す）、ほかの段落の文字を含む要素。触れない。
 * - 'none'：文字も見た目も無い要素。触れない。
 */
function roleOf(el, parent, holders) {
  if (!isInline(el)) return 'foreign';
  if (isInlineCode(el) || (skipElement(el) && /\S/.test(el.textContent))) return 'code';
  if (holders.prose.has(el)) return isLink(el) || !sameLook(el, parent) ? 'wrap' : 'pass';
  if (holders.any.has(el)) return 'code';
  if (/\S/.test(el.textContent)) return 'foreign';
  return visibleVoid(el) ? 'void' : 'none';
}

/** el から stop の手前までに、インラインコードがあるか（el 自身を含む）。 */
function insideCode(el, stop) {
  for (let x = el; x && x !== stop; x = x.parentElement) if (isInlineCode(x)) return true;
  return false;
}

/**
 * 訳文を置く場所。段落の文字をすべて含むいちばん内側の要素（太字だけの行・見出しのリンクなら、その要素。訳文も太字・リンクのまま）。
 * 原文のラッパーと、コードの中には置かない（コードの中身を地の文として訳してしまう。2026-11-16、MDN のサイドバーの
 * 「ブロックのリンクの中のコードだけ」の項目114件を訳しに行き、全体が81%遅くなった）。
 */
function rootOf(block, nodes) {
  let root = nodes[0]?.parentElement;
  if (!root || !block.contains(root)) return block;
  while (root !== block && (root.hasAttribute('data-plamo-orig') || insideCode(root, block) || !nodes.every((n) => root.contains(n)))) root = root.parentElement;
  return root;
}

/**
 * 段落の DOM を読む。返すもの：
 * - tokens：shared/markup.js のトークン列
 * - marks：要素の番号（id）-1 → { kind: 'a'|'c'|'v', el }。訳文を組み立てるときに写す元の要素
 * - hide：訳文表示で隠す要素（中身がすべてこの段落のもの。訳文に写しが入るので、原文側に残さない）
 * - root：訳文を置く要素
 */
export function readParagraph(block, nodes) {
  const set = new Set(nodes);
  const root = rootOf(block, nodes);
  // 段落の文字を含む要素（any）と、そのうち訳す文字（コードの外の文字）を含む要素（prose）。
  const holders = { any: new Set(), prose: new Set() };
  for (const n of nodes) {
    const sets = insideCode(n.parentElement, root) ? [holders.any] : [holders.any, holders.prose];
    for (const held of sets) for (let el = n.parentElement; el && el !== root && !held.has(el); el = el.parentElement) held.add(el);
  }

  const tokens = [];
  const marks = [];
  const hide = [];
  const mark = (kind, el) => marks.push({ kind, el });
  /** parent の中身を読む。中身がすべてこの段落のもの（隠してよい）なら true。 */
  const walk = (parent) => {
    let owned = true;
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (set.has(child)) tokens.push({ type: 'text', text: child.data });
        else if (/\S/.test(child.data)) owned = false; // ほかの段落の文字
        else tokens.push({ type: 'space' }); // 落とすと「featuresRead only」のように語がつながる（2026-11-11）
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE || child.matches(UI)) continue;
      if (child.hasAttribute('data-plamo-orig')) { // 原文の文字のラッパー
        owned = walk(child) && owned;
        continue;
      }
      const role = roleOf(child, parent, holders);
      if (role === 'foreign') owned = false;
      else if (role === 'code') {
        tokens.push({ type: 'code', id: mark('c', child), text: child.textContent });
        hide.push(child);
      } else if (role === 'void') {
        tokens.push({ type: 'void', id: mark('v', child), br: child.tagName === 'BR' });
        hide.push(child);
      } else if (role === 'wrap' || role === 'pass') {
        const id = role === 'wrap' ? mark('a', child) : 0;
        if (id) tokens.push({ type: 'open', id });
        const own = walk(child);
        if (id) tokens.push({ type: 'close', id });
        if (own) hide.push(child);
        owned = owned && own;
      }
    }
    return owned;
  };
  walk(root);
  return { tokens, marks, hide, root };
}

/**
 * 段落を、モデルに渡すマーカー付きの1行にする。返すもの：text・plain（shared/markup.js の encode）と、marks・hide・root（readParagraph）。
 * 以前はリンクとコードだけを名指しで拾い、原文は文字だけを隠していたので、名簿に無い要素が訳文から消え（太字・改行）、
 * 文字以外の中身が訳文表示で残っていた（コードの空の箱、<br> の空行）。2026-11-16、要素の種類ごとの対処をやめてこの流れにした。
 */
export function markup(block, nodes) {
  const { tokens, marks, hide, root } = readParagraph(block, nodes);
  return { ...encode(tokens), marks, hide, root };
}
