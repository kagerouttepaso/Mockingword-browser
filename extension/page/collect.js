// 段落を集める。ページの文字のノードを、見た目の段落（ブロック要素）ごとにまとめ、項目のグループ（group）を決める。
// 要素の判定は page/dom.js、段落の中身の読み取りとマーカーは page/paragraph.js。設計は docs/04_ページの翻訳.md「段落の集め方」。

import { worthTranslating } from '../shared/text.js';
import { OWN, blockOf, isInlineCode, skipElement } from './dom.js';
import { markup } from './paragraph.js';
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
 * 段落は { element, nodes, text, marks, hide, root, group, translation, trSpan }（markup の返り値を参照）。
 */
export function collect(root) {
  // 訳さない要素（SVG・コード・入力欄など）の中なら何もしない（root 自身は絞り込みを通らないため、先に祖先を見る）。
  for (let el = root; el && el !== document.body; el = el.parentElement) if (skipElement(el) && !isInlineCode(el)) return [];
  const groups = new Map(); // ブロック要素 → 文字のノードの並び
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (isInlineCode(node)) return NodeFilter.FILTER_SKIP; // 中へ入る（マーカーで囲み、訳文に原文のまま戻す）
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
    const { text, plain, marks, hide, root, fontFamily } = markup(element, nodes);
    if (!worthTranslating(plain)) continue;
    const para = { element, nodes, text, marks, hide, root, fontFamily, group: groupOf(element, nodes), translation: null, trSpan: null };
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
