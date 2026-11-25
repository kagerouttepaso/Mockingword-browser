// 段落を集める。ページの文字のノードを、見た目の段落（ブロック要素）ごとにまとめ、項目のグループ（group）を決める。
// 要素の判定は page/dom.js、段落の中身の読み取りとマーカーは page/paragraph.js。設計は docs/04_ページの翻訳.md「段落の集め方」。

import { OWN, blockOf, isBlockBreaker, isInlineCode, preservesNewlines, skipElement } from './dom.js';
import { createPara } from './para.js';
import { state } from './state.js';


const ITEM_GROUP = 'ul, ol, menu, nav, dl, details, tr, [role="list"], [role="row"], [role="menu"], [role="menubar"], [role="navigation"], [role="tree"], [role="tablist"], [role="group"]';
const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
const NAV_GROUP = 'nav, [role="navigation"], footer, [role="contentinfo"]';

/**
 * 項目のグループ。最も内側のリスト・ナビ・ツリーの枝・表の行などの要素そのものを鍵にする。
 * 見出しだけで節を推測すると短い本文まで項目扱いになるため、構造が明示されていない段落は本文に残す。
 * DOMの移動にも追従できるよう、送信する直前にも取り直す。レイアウトの測定は行わない。
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

/**
 * root の下の文字を、見た目の段落ごとにまとめる。まだ集めていない文字だけを集める。
 * 同じブロック要素の中でも、間に別のブロックレベル要素（ul・h2 等）や、改行を保持する white-space 内の
 * 改行文字（\n・\n\n）が挟まった場合は前後を別の段落に分け、改行文字自体は原文 DOM に残す。
 * 段落のフィールドは page/para.js。
 */
export function collect(root) {
  // 訳さない要素（SVG・コード・入力欄など）の中なら何もしない（root 自身は下の走査へ入る前に祖先を見る）。
  for (let el = root; el && el !== document.body; el = el.parentElement) if (skipElement(el) && !isInlineCode(el)) return [];
  const segments = []; // [ブロック要素, 文字のノードの並び]
  const active = new Map(); // ブロック要素 → 現在進行中の区間のノード配列
  const closeAncestors = (el) => {
    for (let a = el.parentElement; a; a = a.parentElement) active.delete(a);
  };
  const walk = (node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches(OWN)) return;
      if (node !== root && isBlockBreaker(node)) closeAncestors(node);
      if (skipElement(node) && !isInlineCode(node)) return;
      for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
      return;
    }
    if (node.nodeType !== Node.TEXT_NODE) return;
    const parent = node.parentElement;
    if (!parent || state.seen.has(node)) return;
    // white-space が改行を保持する要素では、テキスト内の \n（連続する空行を含む）でノードを分割し、
    // 改行だけのノードを段落に含めず原文 DOM に残して前後の区間を区切る。
    if (preservesNewlines(parent) && node.data.includes('\n')) {
      const m = /^(\r?\n+|[^\r\n]+)/.exec(node.data);
      if (m && m[0].length < node.data.length) node.splitText(m[0].length);
      if (node.data.includes('\n')) {
        active.delete(blockOf(parent));
        return;
      }
    }
    if (!/\S/.test(node.data)) return;
    const block = blockOf(parent);
    let list = active.get(block);
    if (!list) {
      list = [];
      active.set(block, list);
      segments.push([block, list]);
    }
    list.push(node);
  };
  walk(root);
  const added = [];
  for (const [element, nodes] of segments) {
    const para = createPara(element, nodes);
    if (para) added.push(para);
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
