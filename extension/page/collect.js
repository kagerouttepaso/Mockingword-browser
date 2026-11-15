// 段落を集める。ページの文字を、見た目の段落（ブロック要素）ごとに1つの文にまとめ、リンク・インラインコードに目印を付ける。
// 何を訳さないかの規則もここに置く。設計は docs/04_ページの翻訳.md「段落の集め方」。

import { normalize, worthTranslating } from '../shared/text.js';
import { state } from './state.js';

/** 中身を訳さない要素。コード・入力欄・数式など。名前は大文字にそろえて比べる。 */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT',
  'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'HEAD', 'TITLE',
]);
const XHTML = 'http://www.w3.org/1999/xhtml';
/** 拡張機能自身の要素（訳文・原文の包み・吹き出し・バー）。 */
export const OWN = '.plamo-tr, .plamo-ui, .plamo-ui-host, [data-plamo-orig]';

const displayCache = new WeakMap();

/** 行の中に並ぶ要素か（段落の区切りにならない）。inline-block（ボタンなど）は独立した段落として訳す。 */
export function isInline(el) {
  let d = displayCache.get(el);
  if (d === undefined) {
    d = getComputedStyle(el).display;
    displayCache.set(el, d);
  }
  return d === 'inline' || d === 'contents';
}

/**
 * 中を訳さない要素か。SVG・MathML の中（グラフの文字や、グラフ部品が入れる <style>）は丸ごと訳さない
 * （SVG の中の要素は tagName が小文字になるので、名前だけで比べると通り抜ける。2026-11-09、GitHub の利用状況のグラフで
 * CSS 3373字を段落として訳しに行き41秒待たされた）。
 */
export function skipElement(el) {
  if (el.namespaceURI !== XHTML) return true;
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.isContentEditable) return true;
  if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate')) return true;
  if (el.matches('.plamo-tr, .plamo-ui, .plamo-ui-host')) return true;
  return false;
}

/** 段落の中のインラインコード。訳さずに、訳文に原文のまま戻す。 */
const INLINE_CODE = new Set(['CODE', 'KBD', 'SAMP', 'VAR']);
export const isInlineCode = (el) => el.namespaceURI === XHTML && INLINE_CODE.has(el.tagName) && !el.closest('pre') && isInline(el);

/** 要素から、見た目の段落（行の中に並ぶ要素を除いた、いちばん近いブロック要素）までさかのぼる。 */
export function blockOf(el) {
  while (el.parentElement && isInline(el)) el = el.parentElement;
  return el;
}

const ITEM_GROUP = 'ul, ol, menu, nav, dl, details, tr, [role="list"], [role="row"], [role="menu"], [role="menubar"], [role="navigation"], [role="tree"], [role="tablist"], [role="group"]';
const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const NAV_GROUP = 'nav, [role="navigation"], footer, [role="contentinfo"]';

/**
 * 項目のまとまり。最も内側のリスト・ナビ・ツリーの枝・表の行などの要素そのものを鍵にする。
 * 見出しだけで節を推測すると短い本文まで項目扱いになるため、構造が明示されていない段落は本文に残す。
 * DOMの移動にも追従できるよう、送り出す直前にも取り直す。レイアウトの測定は行わない。
 */
export function groupOf(element, nodes = []) {
  // ナビの見出しも本文として訳す。目次のリンク群に混ぜて文の続きとして訳させない。
  // display:inlineの見出しからblockOfが親へ上がった場合も、文字のノードから見出しを見つける。
  if (element.closest(HEADING) || nodes.some((n) => n.parentElement?.closest(HEADING))) return null;
  const entry = element.closest('dt, dd');
  const dl = entry?.closest('dl');
  if (dl) {
    // HTMLの「dtが1つ以上、その後にddが1つ以上」を1組とする。divで包まれた組も兄弟の範囲で扱える。
    let unit = entry;
    for (let prev = unit.previousElementSibling; prev; prev = unit.previousElementSibling) {
      if (prev.tagName === 'DT' || (unit.tagName === 'DD' && prev.tagName === 'DD')) unit = prev;
      else break;
    }
    return { key: dl, kind: 'definitions', unit, scope: dl.closest(NAV_GROUP) ? 'navigation' : 'body' };
  }
  for (let el = element.closest(ITEM_GROUP); el; el = el.parentElement?.closest(ITEM_GROUP)) {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    let kind;
    if (role === 'group') {
      if (!el.closest('[role="tree"]')) continue;
      kind = 'tree';
    } else if (tag === 'tr' || role === 'row') kind = 'table-row';
    else if (role === 'tree') kind = 'tree';
    else if (role === 'tablist') kind = 'tabs';
    else if (tag === 'menu' || role === 'menu' || role === 'menubar') kind = 'menu';
    else if (tag === 'nav' || role === 'navigation') kind = 'navigation';
    else if (tag === 'ul' || tag === 'ol' || role === 'list') kind = 'list';
    else if (tag === 'dl') return null; // dt/ddに属さない文字は本文。定義の組を推測しない。
    else if (tag === 'details') kind = 'disclosure';
    // ナビ・フッター内のul・detailsは同じ種類のメニュー項目。dt/ddの組は上で別に扱う。
    if (!['tree', 'tabs', 'table-row'].includes(kind) && el.closest(NAV_GROUP)) kind = 'navigation';
    return { key: el, kind };
  }
  return null;
}

/** 文字のノードを包む、訳文にも残す要素（段落の中で一番外側のリンクかインラインコード）。無ければ null。 */
function keptWrapper(node, block) {
  let kept = null;
  for (let el = node.parentElement; el && el !== block; el = el.parentElement) {
    if ((el.tagName === 'A' && el.hasAttribute('href')) || isInlineCode(el)) kept = el;
  }
  return kept;
}

/** 隣り合う2つの文字のノードの間に、どちらにも含まれない空白があるか（飛ばした空白だけのノードなど）。 */
function gapBetween(a, b) {
  if (/\s$/.test(a.data) || /^\s/.test(b.data)) return false;
  const range = document.createRange();
  range.setStartAfter(a);
  range.setEndBefore(b);
  return /\s/.test(range.toString());
}

/**
 * 段落の文字を、訳文にも残す要素を番号付きの目印で囲んで1行にする（リンク：<a1>…</a1>、コード：<c1>…</c1>）。
 * PLaMo は目印を保ったまま訳す（2026-11-09、0.8B・2Bとも、リンク2つの文などで崩れなかった）。
 * 段落の文字がすべて同じリンクの中なら目印は付けない（訳文をリンクの中に置くため）。
 * 返す plain は目印を除いた訳す文字（訳す価値の判定用）、marks は目印の番号→要素。
 */
export function markup(block, nodes) {
  const wrappers = nodes.map((n) => keptWrapper(n, block));
  // 集めるときは空白だけのノードを飛ばすので、要素の間の空白（`</a> <span>`）を戻す。
  // 戻さないと MDN の「features」と札の「Read only」が「featuresRead only」とつながり、
  // モデルが1語の識別子と見て訳さずに返した（2026-11-11、現行・グループ版とも）。
  const data = nodes.map((n, j) => (j > 0 && gapBetween(nodes[j - 1], n) ? ' ' : '') + n.data);
  const allInOneLink = wrappers[0]?.tagName === 'A' && wrappers.every((w) => w === wrappers[0]);
  const marks = { a: [], c: [] };
  let text = '';
  let plain = '';
  let i = 0;
  while (i < nodes.length) {
    const w = allInOneLink ? null : wrappers[i];
    let piece = '';
    while (i < nodes.length && (allInOneLink || wrappers[i] === w)) piece += data[i++];
    piece = piece.replace(/\s+/g, ' ');
    if (!w || !piece.trim()) {
      text += piece;
      plain += piece;
      continue;
    }
    const kind = w.tagName === 'A' ? 'a' : 'c';
    let k = marks[kind].indexOf(w);
    if (k < 0) k = marks[kind].push(w) - 1;
    const lead = piece.match(/^\s*/)[0];
    const trail = piece.match(/\s*$/)[0];
    text += `${lead}<${kind}${k + 1}>${piece.trim()}</${kind}${k + 1}>${trail}`;
    if (kind === 'a') plain += piece; // コードは訳さないので、訳す価値の判定に入れない
  }
  return { text: text.trim(), plain: normalize(plain), marks };
}

/**
 * root の下の文字を、見た目の段落ごとにまとめる。まだ集めていない文字だけを集める。
 * 段落は { element, nodes, text, marks, group, translation, trSpan }。
 */
export function collect(root) {
  // 訳さない要素（SVG・コード・入力欄など）の中なら何もしない（root 自身は絞り込みを通らないため、先に祖先を見る）。
  for (let el = root; el && el !== document.body; el = el.parentElement) if (skipElement(el) && !isInlineCode(el)) return [];
  const groups = new Map(); // ブロック要素 → 文字のノードの並び
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (isInlineCode(node)) return NodeFilter.FILTER_SKIP; // 中へ入る（目印で囲み、訳文に原文のまま戻す）
        return skipElement(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      if (state.seen.has(node) || !/\S/.test(node.data)) return NodeFilter.FILTER_SKIP;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement || node.parentElement.closest(OWN)) continue;
    const block = blockOf(node.parentElement);
    let list = groups.get(block);
    if (!list) groups.set(block, (list = []));
    list.push(node);
  }
  const added = [];
  for (const [element, nodes] of groups) {
    const { text, plain, marks } = markup(element, nodes);
    if (!worthTranslating(plain)) continue;
    const para = { element, nodes, text, marks, group: groupOf(element, nodes), translation: null, trSpan: null };
    for (const n of nodes) {
      state.seen.add(n);
      state.owner.set(n, para);
    }
    added.push(para);
  }
  return added;
}

/**
 * 範囲（選択範囲）にかかる段落のブロック要素。範囲の中の文字のノードから段落までさかのぼり、重ねずに返す。
 * 親子の両方が入ったときは親だけにする（collect が子の段落も集めるため）。
 */
export function blocksInRange(range) {
  const rootNode = range.commonAncestorContainer;
  const root = rootNode.nodeType === Node.ELEMENT_NODE ? rootNode : rootNode.parentElement;
  const blocks = new Set();
  const add = (textNode) => {
    const el = textNode.parentElement;
    if (el && !el.closest(OWN)) blocks.add(blockOf(el));
  };
  if (rootNode.nodeType === Node.TEXT_NODE) add(rootNode);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (/\S/.test(n.data) && range.intersectsNode(n)) add(n);
  return [...blocks].filter((b) => ![...blocks].some((o) => o !== b && o.contains(b)));
}
