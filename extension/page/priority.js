// 訳す順番の点数。小さいほど先。送るたびに待っている段落すべてを測り直すので、スクロール・マウスの位置で順番が変わる。
// 点数＝位置（画面内→下→上→見えない）＋場所（本文を先、ナビ・サイドバー・ヘッダー・フッターを後）＋段落の性質。
// 画面内の本文は、見出し→第1段落→本文→注記の段で並べ、同じ段の中は上から（shared/text.js の READING_TIER）。
// マウスを約0.3秒載せた段落は列の先頭に回す。設計は docs/04_ページの翻訳.md「訳す順番」。

/** 注目している場所（ダイアログ・ツールチップ）。見えていれば何より先に訳す。 */
import { READING_TIER, headingLike, markLeads } from '../shared/text.js';

const FOCUS = '[role="dialog"], [role="alertdialog"], [role="tooltip"], [aria-modal="true"], dialog[open]';
/** 本文。 */
const MAIN = 'main, article, [role="main"], [itemprop="articleBody"], .markdown-body, #content, #main-content, .mw-parser-output';
/** ナビゲーション・サイドバー・メニュー。本文の中にあってもナビとして扱う。 */
const NAV = 'nav, aside, [role="navigation"], [role="complementary"], [role="menu"], [role="menubar"], [role="tree"], [role="tablist"]';
/** ページの枠（ヘッダー・フッター）。本文の外にあるときだけナビとして扱う（記事の見出しの header は本文）。 */
const FRAME = 'header, footer, [role="banner"], [role="contentinfo"]';

/** 見出し・ボタン・注記の見分け。見出しタグのないサイト（GitHub のモデル名は太字の p）は、見た目（太字・大きい字）で見る。 */
const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const CONTROL = 'button, [role="button"], select, option, [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"]';
const NOTE = '[role="note"], small, figcaption, sup, sub';
/** 画面内の段の幅（画面の高さに対する割合）。4段で画面1つ分に収まり、画面内の段落はどれも画面外の段落より先になる。 */
const TIER_SPAN = 0.25;

/** 場所ごとの後回しの量（画面の高さに対する割合）。ナビは、見えていても1画面分下の本文と同じくらい後にする。 */
const REGION_COST = { focus: -1, main: 0, neutral: 0.25, nav: 1 };
/** 全部がリンクの段落（メニューの項目など）、短いラベルの後回しの量。 */
const LINKY_COST = 0.3;
const SHORT_COST = 0.15;
const SHORT_CHARS = 12;
/** マウスを約0.3秒載せた段落。 */
const HOVER_SCORE = -1e6;
/** 見えない段落（閉じたメニューなど）。 */
const HIDDEN_SCORE = 1e8;

/** 段落がどこにあるか。'focus'・'main'・'nav'・'neutral'。DOM の形は変わりにくいので段落に覚える。 */
export function regionOf(para) {
  if (para.region) return para.region;
  const el = para.element;
  const nav = el.closest(NAV);
  const main = el.closest(MAIN);
  if (el.closest(FOCUS)) para.region = 'focus';
  // h1 はサイトがどこに置いてもページのタイトル。ヘッダーの中でナビ扱いにすると、本文を訳し終えても英語のまま残る
  // （sakutto の dom/priority.ts と同じ判断。ただしナビの中の h1 はロゴなのでナビのまま）。
  else if (el.closest('h1') && !nav) para.region = 'main';
  else if (nav && (!main || main.contains(nav))) para.region = 'nav';
  else if (main) para.region = 'main';
  else if (el.closest(FRAME)) para.region = 'nav';
  else para.region = 'neutral';
  return para.region;
}

/** 段落の種類（見出し・本文・ボタン・注記）。第1段落（lead）は markReading が並びから決める。 */
function baseKind(para) {
  const el = para.element;
  if (el.closest(CONTROL)) return 'control';
  if (el.closest(HEADING)) return 'heading';
  if (el.closest(NOTE)) return 'note';
  const node = para.nodes.find((n) => n.isConnected)?.parentElement ?? el;
  const cs = getComputedStyle(node);
  const base = parseFloat(getComputedStyle(document.body).fontSize) || 16;
  const size = parseFloat(cs.fontSize) || base;
  if (!linky(para) && headingLike(para.text, { weight: parseInt(cs.fontWeight, 10) || 400, size, base })) return 'heading';
  if (cs.fontStyle === 'italic' || size < base * 0.9) return 'note';
  return 'body';
}

/**
 * DOM順に集めた段落に種類を付ける（para.kind）。見出しの直後の最初の本文を第1段落にする。
 * ナビの中・全部がリンクの段落は、見出しと第1段落の間にあっても飛ばす（本文の段で扱う）。
 */
export function markReading(paras) {
  const kinds = paras.map((p) => (regionOf(p) === 'nav' || linky(p) ? 'skip' : baseKind(p)));
  markLeads(kinds).forEach((kind, i) => (paras[i].kind = kind === 'skip' ? 'body' : kind));
}

/** 段落の文字がすべてリンクの中か（メニューの項目・パンくずなど）。 */
function linky(para) {
  para.linky ??= para.nodes.every((n) => n.parentElement?.closest('a'));
  return para.linky;
}

// マウスを約0.3秒載せた要素。通りすがりで順番が入れ替わらないよう、少し止まってから先頭に回す。
// mouseover は要素が変わったときだけ来るので軽い。
const HOVER_MS = 300;
let hovered = null;
let hoverTimer = 0;
document.addEventListener('mouseover', (e) => {
  clearTimeout(hoverTimer);
  hovered = null;
  hoverTimer = setTimeout(() => (hovered = e.target), HOVER_MS);
}, { capture: true, passive: true });

/** マウスを載せている段落か。 */
export function isHovered(para) {
  return !!hovered && para.element.contains(hovered);
}

/** 段落の位置（文字の範囲。訳し直しで原文を隠しているときは訳文の位置）。見えなければ null。 */
function rectOf(para) {
  const node = para.nodes.find((n) => n.isConnected);
  if (!node) return undefined;
  // visibility:hidden の要素（閉じたメニューなど）は場所を取るので、checkVisibility で見えているかも見る
  // （2026-11-06、韓国語版Wikipediaで閉じたメインメニューを本文より先に訳していた）。
  const visible = (el) => el?.isConnected && el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
  let r;
  if (visible(node.parentElement)) {
    // 読み上げ用に1pxへ縮めた文字（GitHub の sr-only の見出し「Organization navigation」など）は見えない段落として扱う。
    // 見出しの段に入れると、画面に出ない文字を最初に訳してしまう。
    const box = node.parentElement.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    r = range.getBoundingClientRect();
  } else if (visible(para.trSpan)) {
    r = para.trSpan.getBoundingClientRect();
  } else {
    return null;
  }
  return r.width === 0 && r.height === 0 ? null : r;
}

/** 画面に見えているか（場所によらない）。 */
export function onScreen(para) {
  const r = rectOf(para);
  return !!r && r.bottom > 0 && r.top < window.innerHeight;
}

/** 画面内の本文の見出し・第1段落か。この訳を待つ間は、画面外だけのバッチを後回しにする。 */
export function isFront(para) {
  return READING_TIER[para.kind ?? 'body'] <= READING_TIER.lead && regionOf(para) !== 'nav' && onScreen(para);
}

/** 順番の点数。ページから消えたら Infinity。 */
export function priority(para) {
  const r = rectOf(para);
  if (r === undefined) return Infinity;
  if (r === null) return HIDDEN_SCORE;
  if (isHovered(para)) return HOVER_SCORE;
  const vh = window.innerHeight;
  const region = regionOf(para);
  const visible = r.bottom > 0 && r.top < vh;
  const kind = para.kind ?? 'body';
  let pos;
  // 画面内の本文は段ごとに並べる：見出し（0〜0.25画面）→第1段落→本文→注記。段の中は上からの位置を1/4に縮めて並べる。
  if (visible && region !== 'nav') pos = (READING_TIER[kind] + Math.max(0, r.top) / vh) * TIER_SPAN * vh;
  else if (visible) pos = r.top;
  else if (r.top >= vh) pos = vh + (r.top - vh);
  else pos = vh - r.bottom * 2; // 上にあるものは、下にあるものより後
  let cost = REGION_COST[region];
  if (linky(para)) cost += LINKY_COST;
  if (para.text.length < SHORT_CHARS && kind !== 'heading') cost += SHORT_COST;
  return pos + cost * vh;
}
