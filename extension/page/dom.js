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
/** 拡張機能自身の要素（表示と、原文のラッパー）。 */
export const OWN = UI + ', [data-plamo-orig]';

const displayCache = new WeakMap();
const whiteSpaceCache = new WeakMap();
const LIST_ENTRY = new Set(['LI', 'DT', 'DD']);
/** 改行文字（\n）を空白に潰さず強制改行として表示する white-space の値。 */
const PRESERVE_NEWLINE = new Set(['pre', 'pre-wrap', 'pre-line', 'break-spaces']);

/** 段落の区切りにならないインライン要素か。一覧の項目は横並びでも独立して扱う。 */
export function isInline(el) {
  if (LIST_ENTRY.has(el.tagName)) return false;
  let d = displayCache.get(el);
  if (d === undefined) {
    d = getComputedStyle(el).display;
    displayCache.set(el, d);
  }
  return d === 'inline' || d === 'contents';
}

/** 行を折って前後の段落を分断するブロックレベル要素か（inline-block 等の行内要素は含まない）。 */
export function isBlockBreaker(el) {
  if (LIST_ENTRY.has(el.tagName)) return true;
  let d = displayCache.get(el);
  if (d === undefined) {
    d = getComputedStyle(el).display;
    displayCache.set(el, d);
  }
  return d !== 'contents' && !d.startsWith('inline');
}

/** テキストノード内の改行文字（\n）を改行として保持する要素か。 */
export function preservesNewlines(el) {
  let ws = whiteSpaceCache.get(el);
  if (ws === undefined) {
    ws = getComputedStyle(el).whiteSpace;
    whiteSpaceCache.set(el, ws);
  }
  return PRESERVE_NEWLINE.has(ws);
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

/** 要素から、いちばん近いブロック要素または一覧の項目までさかのぼる。 */
export function blockOf(el) {
  while (el.parentElement && isInline(el)) el = el.parentElement;
  return el;
}
