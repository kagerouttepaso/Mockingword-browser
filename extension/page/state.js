// ページ側の状態と、Service Workerとのやり取り・ログの小さな道具。ページ側のモジュールはこの state を共有する。

import { LOG_TAG, MSG } from '../shared/messages.js';

export const state = {
  /** ページ全体を訳しているか（段落だけ訳したときは false）。 */
  started: false,
  /** 訳文の言語（shared/languages.js のコード）。訳し始めたときの設定の値で、元のページに戻すまで変えない。 */
  target: 'ja',
  /** 表示：'trans'（訳文）・'orig'（原文）・'both'（対訳）。 */
  mode: 'trans',
  /** 原文を表示する前に見せていた表示。原文⇄訳文の切り替えで戻す先。 */
  lastShown: 'trans',
  /** 訳を待つ段落。 */
  pending: new Set(),
  /** 集めた段落すべて。モデルを切り替えたときに訳し直す対象。 */
  all: new Set(),
  /** 送って返事を待っているバッチ。番号 → { paras, texts, t, cancelling }。古くなったら取り消す。 */
  chunks: new Map(),
  /**
   * キャッシュに照会している段落の数（page/queue.js の enqueue）。照会の間は pending にも chunks にも入っていないので、
   * これを数えないと、訳し始めた直後に「訳し終えました」が出る（2026-11-24、モデルの読み込みより前に出ていた）。
   */
  looking: 0,
  seq: 0,
  /** 訳し直し・翻訳の終了のたびに増やす。古いメッセージの返事を捨てるため。 */
  generation: 0,
  /** 翻訳に失敗して止めている。利用者が次に操作したら再開する。 */
  halted: false,
  /** 訳したモデル（Service Workerの返事から）。 */
  model: '',
  /** 原文→訳文のキャッシュ（このページの中だけ）。 */
  cache: new Map(),
  /** 段落に組み込んだ文字のノード。同じノードを2回集めない。 */
  seen: new WeakSet(),
  /** 文字のノード→段落。書き換えられたときに訳し直すため。 */
  owner: new WeakMap(),
  /** 隠す要素→段落。サイトが隠す印を消したときに出し直すため。 */
  hideOwner: new WeakMap(),
  /** 書き換えの監視。 */
  observer: null,
  /** 調査用のログをService Workerへ送るか（設定の「調査用のログ」）。 */
  debugLog: false,
  // 計測（バーの「訳し終えました」と、コンソールのログ）
  t0: 0,
  /** 訳し始めたときに画面に見えていた段落のうち、まだ訳文が届いていないもの。 */
  firstScreen: new Set(),
  firstScreenDone: false,
  translated: 0,
  requests: 0,
  /** 生成したトークン数と、送ったバッチが1本以上あった時間の合計（ミリ秒）。バーの速さ（トークン/秒）に使う。 */
  tokens: 0,
  busyMs: 0,
  /** 送ったバッチが0本から1本になった時刻。0本の間は0。 */
  busySince: 0,
  /** モデルの読み込みを待った時間の最長（ミリ秒）。同時に送ったバッチは同じ読み込みを待つので、足さずに最長を取る。 */
  loadMs: 0,
  notified: false,
};

/**
 * 拡張機能との接続が生きているか。拡張機能を再読み込み・更新すると、開いていたタブに残るこの部品は接続を失い、
 * chrome.runtime.sendMessage が Promise の失敗ではなくその場で例外（Extension context invalidated）を投げる。
 * 切れていたら、バーの更新と書き換えの監視を止めて、何も送らない（2026-11-09、作者の Brave でエラーが出た）。
 */
export function alive() {
  if (chrome.runtime?.id) return true;
  state.observer?.disconnect();
  state.observer = null;
  return false;
}

/**
 * Service Workerへメッセージを送る。Offscreen Documentが作られている最中は行き先が一時的に無くなり
 * 「Receiving end does not exist」で失敗するので、0.2秒おきに5回まで送り直す。
 */
export async function send(message) {
  if (!alive()) throw new Error('拡張機能が更新されました。ページを読み込み直してください。');
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      debug(`送信の失敗（${i + 1}回目）：${e?.message ?? e}`);
      if (i >= 5 || !/Receiving end does not exist/i.test(e?.message ?? '')) throw e;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** 返事を待たずに知らせる。 */
export function notify(message) {
  if (!alive()) return;
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // 接続が切れた直後は、その場で例外になる
  }
}

/** 調査用のログ（設定でオンのときだけService Workerへ送る）。 */
export function trace(event, data) {
  if (state.debugLog) notify({ type: MSG.LOG, event, data: { ...data, page: location.hostname } });
}
chrome.storage.sync.get({ debugLog: false }).then((s) => (state.debugLog = !!s.debugLog));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'sync' && c.debugLog) state.debugLog = !!c.debugLog.newValue;
});

/** 訳し始めてからの秒数。 */
export function seconds() {
  return ((performance.now() - state.t0) / 1000).toFixed(1);
}

/**
 * 生成の速さ（トークン/秒、整数）。返事が届いたバッチのトークン数 ÷（送ったバッチがあった時間 − モデルの読み込みの待ち）。
 * 同時に送った同時実行数分をまとめた全体の速さで、1本あたりではない。まだ返事が無い・測れないときは 0。
 * トークン数は返事が届いたときに足すので、送信中のバッチの分だけ、訳している途中は少なめに出る。
 */
export function tokensPerSecond() {
  // モデルの読み込み（保存済みでも数秒）は生成の速さではないので引く。
  const ms = state.busyMs + (state.busySince ? performance.now() - state.busySince : 0) - state.loadMs;
  return state.tokens > 0 && ms > 0 ? Math.round((state.tokens / ms) * 1000) : 0;
}

export function log(message) {
  console.info(`${LOG_TAG} ${message}`);
}

/** 速さの調査用。開発者ツールのコンソールで「詳細」を表示すると見える。 */
export function debug(message) {
  console.debug(`${LOG_TAG} ${((performance.now() - (state.t0 || performance.now())) / 1000).toFixed(2)}s ${message}`);
}
