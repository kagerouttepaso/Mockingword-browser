// 拡張機能の部品の間でやり取りするメッセージの種類（chrome.runtime.sendMessage・chrome.tabs.sendMessage の type）。
// 送る側と受ける側はこの一覧で名前をそろえる。部品とメッセージの流れは docs/02_アーキテクチャ.md「メッセージの一覧」。
// page/watch.js（すべてのページに入る通常のスクリプト）だけは import できないので、同じ文字列を直接書いている。

export const MSG = {
  // ページ（page/）→ Service Worker
  TRANSLATE_BATCH: 'translate-batch', // { texts, id } → { ok, results, stats: { requests, fallback, tokens, loadMs }, model } | { ok:false, cancelled }
  CACHE_LOOKUP: 'cache-lookup', // { texts } → { results: (訳|null)[], model }
  CANCEL: 'cancel', // { id }：古くなったバッチを取り消す
  PAGE_STATE: 'page-state', // { mode, host }：同じサイト内の自動翻訳のために表示を知らせる
  PROGRESS: 'progress', // { pending }：ボタンのバッジ
  LOG: 'log', // { event, data, source? }：調査用のログ
  TRANSLATE_ONE: 'translate-one', // { text, source?, lines?, stream? } → { ok, text, model, tokens, genMs }（選択範囲・テキスト翻訳。stream を渡すと途中を TEXT_PARTIAL で知らせる）
  OPEN_TEXT_WITH: 'open-text-with', // { text }：選んだ文章を入れてテキスト翻訳を開く

  // page/watch.js → Service Worker
  PAGE_LOADED: 'page-loaded', // { host }
  SELECTION_ICON: 'selection-icon', // { text }

  // 画面（ui/）→ Service Worker
  STATUS: 'status', // → { loaded, loading, device, threads, adapter, parallel, ubatch, model, idleMinutes, lastUse }
  UNLOAD: 'unload',
  PAGE_ACTION: 'page-action', // { tabId, action: 'toggle'|'trans'|'orig'|'both'|'stop' }
  SWITCH_MODEL: 'switch-model', // { model, tabId }
  OPEN_TEXT: 'open-text',
  CACHE_CLEAR: 'cache-clear',
  CACHE_STATS: 'cache-stats', // → { count, bytes, limit, usage }
  LOGS_GET: 'logs-get',
  LOGS_CLEAR: 'logs-clear',
  SPEED_TEST: 'speed-test', // → { ok, row }：今の設定で速さを測る
  TUNE: 'tune', // → { ok, result }：このPCに合わせる（設定を変えて測り、いちばん速い設定を保存する）
  TUNE_STOP: 'tune-stop',

  // Offscreen Document（offscreen/）→ Service Worker
  MODEL_PROGRESS: 'local-progress', // { model, loaded, total }
  PARTIAL: 'partial', // { requestId, text }：まとめ訳しの生成の途中（訳し終わった行を先に出すため）

  // Service Worker → 設定画面
  TUNE_PROGRESS: 'tune-progress', // { text?, rows? }：速さの調整の途中経過

  // Service Worker → ページ
  TOGGLE: 'toggle', // { mode }：未翻訳なら訳す、訳した後は原文⇄訳文
  START: 'start', // { mode }
  STOP: 'stop', // 翻訳をやめて元のページに戻す
  RETRANSLATE: 'retranslate', // { model }
  NOTICE: 'notice', // { text }：モデルの準備の進み具合
  TRANSLATE_SELECTION: 'translate-selection', // { text }：選択範囲の訳を吹き出しで出す
  TRANSLATE_SELECTED_PARAGRAPHS: 'translate-selected-paragraphs', // { mode }：選択した段落を訳文に置き換える
  GET_STATE: 'get-state', // → { translating }
  SHOW_PARTIAL: 'show-partial', // { id, lines: [{ i, text }] }：バッチのうち訳し終わった行

  // Service Worker → テキスト翻訳（ui/translate.js）
  TAKE_TEXT: 'take-text',
  TEXT_PARTIAL: 'text-partial', // { stream, text, tokens, genMs }：テキスト翻訳の訳文の途中（0.1秒おき）

  // Service Worker → Offscreen Document（{ target: 'offscreen' } を付ける）
  COMPLETE: 'complete', // { requestId, model, device, threads, parallel, ubatch, prompt, maxTokens, lines, stop, debugLog } → { ok, text, cut, tokens, genMs, loadMs } | { ok:false, cancelled }
  MODEL_STATUS: 'status',
  MODEL_CANCEL: 'cancel', // { requestId }
};

export const OFFSCREEN = 'offscreen';

/** ページ側の調査用のログの頭。計測ツール（tools/page-replay.mjs・tools/bench.mjs）もこれで行を拾う（名前を変えたときにツールが黙って行を拾えなくなった。2026-11-16）。 */
export const LOG_TAG = '[Mockingword]';

/** 調査用のログの出どころ（logs-get の source）。拡張と計測ツール（tools/profile/replay-quality.mjs など）が同じ名前で照合する。 */
export const LOG_SOURCE = { page: 'page', background: 'background', model: 'model' };
