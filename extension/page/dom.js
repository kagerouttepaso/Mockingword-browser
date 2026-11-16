// ページの要素の見方の基本（DOM の判定だけ）。段落を集める page/collect.js と、段落を読む page/paragraph.js が共有する。
// 何を訳さないか・何が行の中の要素かの判定はここだけに置く（docs/11_設計方針.md）。

/** 中身を訳さない要素。コード・入力欄・数式など。名前は大文字にそろえて比べる。 */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT',
  'SELECT', 'OPTION', 'SVG', 'MATH', 'CANVAS', 'IFRAME', 'OBJECT', 'HEAD', 'TITLE',
]);
export const XHTML = 'http://www.w3.org/1999/xhtml';
/** 拡張機能が足す表示（訳文・吹き出し・バー）。 */
export const UI = '.plamo-tr, .plamo-ui, .plamo-ui-host';
/** 拡張機能自身の要素（表示と、原文の包み）。 */
export const OWN = UI + ', [data-plamo-orig]';

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
  if (el.matches(UI)) return true;
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
