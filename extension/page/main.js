// ページ側の本体。Service Workerからの指示を受け、ページ全体・選択した段落の翻訳、表示の切り替え、翻訳の終了を行う。
// page/loader.js が import する。設計は docs/04_ページの翻訳.md。

import { MSG } from '../shared/messages.js';
import { short, worthTranslating } from '../shared/text.js';
import { initBar, removeBar, setBarDone, showBar, updateBar, barMessage } from './bar.js';
import { clearNotice, notice, toast, translateSelection } from './bubble.js';
import { blocksInRange, collect } from './collect.js';
import { OWN } from './dom.js';
import { initPageFonts } from './fonts.js';
import { markup } from './paragraph.js';
import { cancelStale, enqueue, pump, report, resetMeasure, showPartial } from './queue.js';
import { log, notify, state, trace } from './state.js';
import { apply, clearPartial, removeAll, setModeClass, setWorking, showingTranslation } from './write.js';

// ---------------- 表示の切り替え ----------------

function setMode(mode) {
  setModeClass(mode);
  state.mode = mode;
  if (mode !== 'orig') {
    state.lastShown = mode;
    state.halted = false; // 失敗で止めていても、利用者が操作したらもう一度試す
    pump(); // 原文表示の間は止めていた続きを訳す
  }
  updateBar();
  // ページ全体を訳しているときは、表示をService Workerに知らせる（同じサイト内で移ったページも続けて訳すため。原文なら止める）。
  if (state.started) notify({ type: MSG.PAGE_STATE, mode, host: location.hostname });
}

/** 段落だけ訳したときなど、訳文を見せる表示になっていなければ、訳文の表示にする。 */
function showTranslation(mode) {
  if (!showingTranslation()) setMode(state.started ? state.lastShown : mode);
}

// ---------------- ページ全体 ----------------

function start(mode) {
  initPageFonts();
  showBar();
  if (state.started) return setMode(mode);
  state.started = true;
  const paras = collect(document.body);
  resetMeasure(paras);
  setMode(mode); // started を立ててから呼ぶ（Service Workerへ表示を知らせる）
  enqueue(paras);
  observe();
  log(`段落 ${paras.length} 件を訳し始めます（画面内 ${state.firstScreen.size} 件）`);
}

/**
 * 翻訳をやめて元のページに戻す（バーの ×、ボタンのメニューの「元のページに戻す」）。
 * 訳文を消し、原文のラッパーを外し、書き換えの監視と送信を止める。同じサイト内の自動翻訳も止める（原文と同じ扱い）。
 * キャッシュ（cache）は残すので、もう一度訳すときはリクエストずに出せる。
 */
function stop() {
  state.generation++; // 送ったバッチの返事が後から届いても捨てる
  state.observer?.disconnect();
  state.observer = null;
  state.pending.clear();
  removeAll();
  notify({ type: MSG.PAGE_STATE, mode: 'orig', host: location.hostname });
  Object.assign(state, { started: false, mode: 'trans', t0: 0, seen: new WeakSet(), owner: new WeakMap() });
  state.all.clear();
  removeBar();
  clearNotice();
  report();
}

/** モデルを切り替えたとき、訳した段落を新しいモデルで訳し直す。届くまでは前の訳を見せておく。 */
function retranslate(model) {
  if (!state.started && state.all.size === 0) return;
  state.generation++;
  state.cache.clear();
  state.pending.clear();
  const again = [];
  setWorking(state.all, false);
  for (const para of state.all) {
    clearPartial(para);
    if (!para.nodes.some((n) => n.isConnected)) {
      state.all.delete(para);
      continue;
    }
    para.translation = null;
    again.push(para);
  }
  resetMeasure(again);
  state.halted = false;
  showBar();
  setBarDone('');
  barMessage(null);
  log(`${model} で訳し直します`);
  if (state.mode === 'orig') setMode(state.lastShown);
  enqueue(again); // 新しいモデルのキャッシュにある訳は先に置き換える
}

// ---------------- 選択した段落 ----------------

/**
 * 段落（ブロック要素）の並びだけを訳して置き換える（ページ全体は訳さない）。後でバーの「ページ全体を訳す」で残りを訳す。
 * 既に集めた段落（訳した・訳を待っている）なら、表示を訳文にするだけでよい。
 */
function translateBlocks(blocks, mode, what) {
  const paras = blocks.flatMap((b) => collect(b));
  const known = paras.length === 0 && [...state.all].some((p) => blocks.some((b) => b.contains(p.element) || p.element.contains(b)));
  if (paras.length === 0 && !known) {
    toast(`${what}には訳す文章がありません（日本語・コード・入力欄は訳しません）。`);
    return;
  }
  showTranslation(mode);
  state.halted = false;
  showBar();
  log(`${what}を訳します（${paras.length} 件）`);
  enqueue(paras);
}

/** 選択範囲にかかる段落。選択範囲の訳を吹き出しで出す代わりに、段落ごと訳文に置き換える。 */
function translateSelectedParagraphs(mode) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) {
    toast('文章を選んでから右クリックしてください。', true);
    return;
  }
  const blocks = blocksInRange(selection.getRangeAt(0)).filter((b) => b !== document.body && b !== document.documentElement);
  translateBlocks(blocks, mode, '選択した段落');
  selection.removeAllRanges(); // 置き換えた訳文が選択の色で見えにくくならないように外す
}

// ---------------- 後から増えた・変わった文字 ----------------

/** 書き換えが落ち着くまで待つ時間。ドラッグで凡例が次々に変わる間などに、途中の文を訳しに行かない。 */
const SETTLE_MS = 700;
/** 訳すたびにページが同じ段落を書き換える（React などの描き直し）と止まらないので、同じ段落の訳し直しは3回まで。 */
const MAX_CHANGES = 3;

/** 同じ段落を出し直すのは3回まで（出すたびにページが入れ直すと止まらないため。MAX_CHANGES と同じ考え方）。 */
const MAX_REVIVES = 3;

/**
 * ページへ戻ってきた、集め済みの文字の段落を出し直す。collect は集め済みの文字を飛ばすので、ここで拾う。
 * - 描き直し（React などの hydration）が、同じ文字のノードをラッパーの外へ入れ直し、訳文を外す。訳文が既にあれば書き直す。
 * - 訳を待つ間に段落が一度ページから外れると、待ち列から落ちる（priority が Infinity）。同じノードが戻ったら列へ入れ直す。
 * どちらも、キャッシュの訳を描画の前に置いたとき（行き来で読み直したページ）に起きやすい。
 * 送っている途中・待ち列にある段落はそのままにする。返す段落は enqueue へ渡す。
 */
function revive(root) {
  const paras = new Set();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const para = state.owner.get(n);
    if (para) paras.add(para);
  }
  const again = [];
  let rewritten = 0;
  for (const para of paras) {
    const nodes = para.nodes.filter((n) => n.isConnected);
    if (nodes.length === 0 || state.pending.has(para)) continue;
    if (para.translation != null) {
      const shown = para.trSpan?.isConnected && nodes.every((n) => n.parentElement?.getAttribute('data-plamo-orig') === 'done');
      if (shown || (para.revives = (para.revives ?? 0) + 1) > MAX_REVIVES) continue;
      apply(para, para.translation);
      rewritten++;
    } else if (![...state.chunks.values()].some((c) => c.paras.includes(para))) {
      if ((para.revives = (para.revives ?? 0) + 1) > MAX_REVIVES) continue;
      again.push(para);
    }
  }
  if (rewritten || again.length) trace('出し直し', { rewritten, again: again.length, texts: again.slice(0, 5).map((p) => short(p.text)) });
  return again;
}

/**
 * 書き換えを見て、足された段落・文字が変わった段落を訳す。GitHub などはページを移るときに body ごと入れ替えるので、
 * 監視は html 要素に付け、body の中だけを集める（head に足された script・style は訳さない）。
 */
function observe() {
  let timer = 0;
  const roots = new Set();
  const changed = new Set();
  const observer = (state.observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (rec.type === 'characterData') {
        const para = state.owner.get(rec.target);
        if (para) changed.add(para);
        continue;
      }
      for (const node of rec.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && !node.matches(OWN)) roots.add(node);
        else if (node.nodeType === Node.TEXT_NODE && node.parentElement) roots.add(node.parentElement);
      }
    }
    if (roots.size === 0 && changed.size === 0) return;
    cancelStale(); // 消えた段落のリクエストは、書き換えが落ち着くのを待たずに取り消す
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.observer !== observer) return; // 翻訳をやめた後に届いた書き換えは訳さない
      const added = [];
      for (const root of roots) {
        if (!root.isConnected || !document.body?.contains(root) || root.closest(OWN)) continue;
        added.push(...collect(root));
        added.push(...revive(root));
      }
      roots.clear();
      for (const para of changed) {
        const { text, plain, marks, hide, root, fontFamily } = markup(para.element, para.nodes.filter((n) => n.isConnected));
        if (text !== para.text && worthTranslating(plain) && (para.changes = (para.changes ?? 0) + 1) <= MAX_CHANGES) {
          clearPartial(para);
          Object.assign(para, { text, marks, hide, root, fontFamily });
          added.push(para);
        }
      }
      changed.clear();
      cancelStale();
      if (!added.length) return;
      trace('書き換え', { added: added.length, texts: added.slice(0, 5).map((p) => short(p.text)) });
      state.t0 ||= performance.now();
      enqueue(added);
    }, SETTLE_MS);
  }));
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

// ---------------- Service Workerからの指示 ----------------

initBar({ onMode: setMode, onWhole: () => start(state.lastShown), onClose: stop });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case MSG.TOGGLE:
      // 未翻訳なら訳す。訳した後は原文⇄（直前の）訳文を切り替える。
      if (!state.started) start(message.mode);
      else {
        showBar();
        setMode(state.mode === 'orig' ? state.lastShown : 'orig');
      }
      break;
    case MSG.START:
      if (!state.started && message.mode === 'orig') break;
      start(message.mode);
      break;
    case MSG.STOP:
      stop();
      break;
    case MSG.RETRANSLATE:
      retranslate(message.model);
      break;
    case MSG.NOTICE:
      notice(message.text);
      break;
    case MSG.TRANSLATE_SELECTION:
      translateSelection(message.text);
      break;
    case MSG.TRANSLATE_SELECTED_PARAGRAPHS:
      translateSelectedParagraphs(message.mode);
      break;
    case MSG.SHOW_PARTIAL:
      showPartial(message.id, message.lines);
      break;
    case MSG.GET_STATE:
      sendResponse({ translating: state.started || state.all.size > 0 });
      break;
  }
});
