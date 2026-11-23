// ページ側の本体。Service Workerからの指示を受け、ページ全体・選択した段落の翻訳、表示の切り替え、翻訳の終了を行う。
// page/loader.js が import する。設計は docs/04_ページの翻訳.md。

import { MSG } from '../shared/messages.js';
import { initBar, removeBar, setBarDone, showBar, updateBar, barMessage } from './bar.js';
import { clearNotice, notice, toast, translateSelection } from './bubble.js';
import { blocksInRange, collect } from './collect.js';
import { initPageFonts } from './fonts.js';
import { enqueue, pump, report, resetMeasure, showPartial } from './queue.js';
import { log, notify, state } from './state.js';
import { connected } from './para.js';
import { observe } from './sync.js';
import { forgetTranslation, removeAll, setDisplayMode, setWorking, showingTranslation } from './write.js';

// ---------------- 表示の切り替え ----------------

function setMode(mode) {
  setDisplayMode(mode);
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
  Object.assign(state, { started: false, mode: 'trans', t0: 0, seen: new WeakSet(), owner: new WeakMap(), hideOwner: new WeakMap() });
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
    if (!connected(para)) {
      state.all.delete(para);
      continue;
    }
    forgetTranslation(para);
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
