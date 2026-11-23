// サイトの書き換えへの追従。ページ全体を訳している間、DOM の書き換えを見て、次の3つを1つの流れで扱う。
// 1. 足された要素：まだ集めていない文字を段落にして訳す（collect）。
// 2. 文字が変わった段落：中身を読み直して訳し直す（refreshPara）。
// 3. 拡張機能が書いたものをサイトが崩した段落：訳文を書き直す・列へ戻す（出し直し）。崩し方は、同じ文字のノードを
//    ラッパーの外へ入れ直す（React などの hydration）、訳文の要素を外す、原文のラッパー・隠す要素の印を消す、のどれか。
// 設計は docs/04_ページの翻訳.md「書き換えの監視」。サイトごとの分岐は置かない。

import { short } from '../shared/text.js';
import { collect } from './collect.js';
import { OWN } from './dom.js';
import { refreshPara } from './para.js';
import { cancelStale, enqueue, isQueued } from './queue.js';
import { state, trace } from './state.js';
import { apply, clearPartial, isShown } from './write.js';

/** 書き換えが落ち着くまで待つ時間。ドラッグで凡例が次々に変わる間などに、途中の文を訳しに行かない。 */
const SETTLE_MS = 700;
/** 訳すたびにページが同じ段落を書き換える（React などの描き直し）と止まらないので、同じ段落の訳し直しは3回まで。 */
const MAX_CHANGES = 3;
/** 同じ段落を出し直すのは3回まで（出すたびにページが崩すと止まらないため。MAX_CHANGES と同じ考え方）。 */
const MAX_REVIVES = 3;
/** 拡張機能がサイトの要素に置く印。サイトが消したら出し直す。 */
const MARKS = ['data-plamo-orig', 'data-plamo-hide'];

/** root の下の、集め済みの文字のノードの段落。 */
function parasIn(root, into) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const para = state.owner.get(n);
    if (para) into.add(para);
  }
}

/**
 * 崩された段落を出し直す。訳文があれば書き直し、訳を待つ間にページから一度外れて待ち列から落ちた段落は列へ戻す
 * （priority が Infinity になると列から外れる）。流れの中にある段落・正しく見えている段落はそのままにする。返す段落は enqueue へ渡す。
 */
function revive(paras) {
  const again = [];
  let rewritten = 0;
  for (const para of paras) {
    if (!para.nodes.some((n) => n.isConnected) || isQueued(para)) continue;
    if (para.translation != null && isShown(para)) continue;
    if ((para.revives = (para.revives ?? 0) + 1) > MAX_REVIVES) continue;
    if (para.translation != null) {
      apply(para, para.translation);
      rewritten++;
    } else {
      again.push(para);
    }
  }
  if (rewritten || again.length) trace('出し直し', { rewritten, again: again.length, texts: again.slice(0, 5).map((p) => short(p.text)) });
  return again;
}

/** 書き換えを見始める。GitHub などはページを移るときに body ごと入れ替えるので、html 要素に付けて body の中だけを集める。 */
export function observe() {
  let timer = 0;
  const roots = new Set();
  const changed = new Set();
  const broken = new Set();
  const observer = (state.observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'characterData') {
        const para = state.owner.get(rec.target);
        if (para) changed.add(para);
      } else if (rec.type === 'attributes') {
        // 拡張機能は 'done' の印を自分では外さない（外すのは翻訳の終了で、監視を止めてから）。外れたらサイトが崩した。
        if (rec.oldValue !== 'done' || rec.target.getAttribute(rec.attributeName) === 'done') continue;
        if (rec.attributeName === 'data-plamo-hide') {
          const para = state.hideOwner.get(rec.target);
          if (para) broken.add(para);
        } else parasIn(rec.target, broken);
      } else {
        for (const node of rec.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && !node.matches(OWN)) roots.add(node);
          else if (node.nodeType === Node.TEXT_NODE && node.parentElement) roots.add(node.parentElement);
        }
        // 訳文の要素が外された。段落は訳文の要素から引けないので、外された訳文を持つ段落を落ち着いてから探す。
        for (const node of rec.removedNodes) if (node.nodeType === Node.ELEMENT_NODE && node.matches('.plamo-tr')) broken.add(null);
      }
    }
    if (roots.size === 0 && changed.size === 0 && broken.size === 0) return;
    cancelStale(); // 消えた段落のリクエストは、書き換えが落ち着くのを待たずに取り消す
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.observer !== observer) return; // 翻訳をやめた後に届いた書き換えは訳さない
      const added = [];
      const revived = new Set([...broken].filter(Boolean));
      if (broken.has(null)) for (const para of state.all) if (para.trSpan && !para.trSpan.isConnected) revived.add(para);
      broken.clear();
      for (const root of roots) {
        if (!root.isConnected || !document.body?.contains(root) || root.closest(OWN)) continue;
        added.push(...collect(root));
        parasIn(root, revived); // collect は集め済みの文字を飛ばすので、戻ってきた文字の段落はここで拾う
      }
      roots.clear();
      for (const para of changed) {
        if ((para.changes ?? 0) >= MAX_CHANGES || !refreshPara(para)) continue;
        para.changes = (para.changes ?? 0) + 1;
        clearPartial(para);
        revived.delete(para);
        added.push(para);
      }
      changed.clear();
      added.push(...revive(revived));
      cancelStale();
      if (!added.length) return;
      trace('書き換え', { added: added.length, texts: added.slice(0, 5).map((p) => short(p.text)) });
      state.t0 ||= performance.now();
      enqueue(added);
    }, SETTLE_MS);
  }));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: MARKS,
    attributeOldValue: true,
  });
}
