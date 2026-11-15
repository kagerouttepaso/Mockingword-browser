// 見えないページ（offscreen/offscreen.js）に置いたモデルへの窓口。裏方（service worker）から使う。
// 見えないページの作成・依頼・取り消し・状態・解放だけを受け持ち、何をどうまとめて訳すかは core/translator.js が決める。

import { buildPrompt, maxTokensFor, STOP } from '../shared/prompt.js';
import { MSG, OFFSCREEN } from '../shared/messages.js';

export class TranslateError extends Error {}
/** 古くなって取り消した問い合わせ。ページへは失敗ではなく「取り消し済み」と返す。 */
export class CancelledError extends Error {}

/**
 * 取り消した問い合わせの番号。まとめ訳しの訳し直しなど、後に続く問い合わせも送らない。
 * 番号はページを読み込むたびに1から振り直すので、その問い合わせを訳し終えたら forget で消す（裏方の main.js）。
 * 消さずにいると、同じタブで次に開いたページの同じ番号の依頼まで即座に取り消され、画面の上の段落が訳されずに残っていた（2026-11-12、0.8.5 まで）。
 */
const cancelled = new Set();

/** 訳し終えた問い合わせの取り消しの記憶を消す。 */
export function forget(requestId) {
  cancelled.delete(requestId);
}

let creating = null;

/** 見えないページを、まだ無ければ作る（拡張機能につき1つ）。 */
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({ url: 'offscreen/offscreen.html', reasons: ['WORKERS'], justification: 'ブラウザー内の翻訳モデル（WebGPU/WASM）を読み込んだまま保持して訳すため' })
    .finally(() => (creating = null));
  await creating;
}

/**
 * 見えないページへ依頼を送る。作った直後はスクリプトがまだ読み込み中で受け付けないので、
 * 受け付けるまで0.1秒おきに送り直す（最大5秒）。2026-11-09、作った直後に同時に送った4本のうち3本が届かず失敗した。
 */
async function send(message) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ target: OFFSCREEN, ...message });
      if (r !== undefined) return r;
    } catch (e) {
      if (!/Receiving end does not exist|message port closed/i.test(e?.message ?? '')) throw e;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

/**
 * 生成の途中を受け取る問い合わせ（テキスト翻訳の逐次表示）。番号 → { onPartial, onTokens, tokens }。
 * 見えないページは stream の問い合わせの途中を0.1秒おきに送ってくる（offscreen.js）。裏方の main.js が streamPartial へ渡す。
 */
const streams = new Map();
let streamSeq = 0;

/** 見えないページから届いた途中経過が、生成の途中を受け取る問い合わせのものなら渡して true を返す。 */
export function streamPartial(message) {
  const s = streams.get(message.requestId);
  if (!s) return false;
  if (message.tokens > s.tokens) {
    s.onTokens?.(message.tokens - s.tokens);
    s.tokens = message.tokens;
  }
  s.onPartial?.(message.text);
  return true;
}

/**
 * 1回の生成。options：{ model, device, threads, parallel, ubatch, source, form, requestId, debugLog }。
 * text の行数を lines として渡し、まとめ訳しで送った行数より多く出し始めたら見えないページが打ち切る。
 * onPartial(訳文の途中)・onTokens(増えたトークン数) を渡すと、生成の途中を受け取る（ページの翻訳の requestId とは併用しない）。
 */
export async function complete(text, options) {
  const streamId = !options.requestId && (options.onPartial || options.onTokens) ? `stream:${++streamSeq}` : null;
  if (!streamId) return completeOnce(text, options);
  const s = { onPartial: options.onPartial, onTokens: options.onTokens, tokens: 0 };
  streams.set(streamId, s);
  try {
    const r = await completeOnce(text, { ...options, requestId: streamId, stream: true });
    if (r.tokens > s.tokens) options.onTokens?.(r.tokens - s.tokens); // 最後の途中経過より後の分
    return r;
  } finally {
    streams.delete(streamId);
  }
}

async function completeOnce(text, options) {
  if (options.requestId && cancelled.has(options.requestId)) throw new CancelledError();
  await ensureOffscreen();
  const r = await send({
    type: MSG.COMPLETE,
    requestId: options.requestId,
    debugLog: options.debugLog,
    model: options.model,
    device: options.device,
    threads: options.threads,
    parallel: options.parallel,
    ubatch: options.ubatch,
    prompt: buildPrompt(text, options),
    maxTokens: maxTokensFor(text),
    lines: text.split('\n').length,
    sourceChars: text.length, // 訳文が原文よりずっと長くなるまでは、繰り返しで打ち切らない
    partial: !!options.partial || !!options.stream, // まとめ訳しの途中経過を知らせてもらう
    stream: !!options.stream, // 行の区切りを待たず、0.1秒おきに途中を知らせてもらう（テキスト翻訳）
    noCache: !!options.noCache, // 速さの調整だけ：前の問い合わせの読み込み済み原文を使わせない（background/tune.js）
    stop: STOP,
  });
  if (r?.cancelled) throw new CancelledError();
  if (!r?.ok) throw new TranslateError(`翻訳に失敗しました：${r?.error ?? '返事がありません'}`);
  return r;
}

/** 問い合わせを取り消す。生成中なら見えないページ側で止める。 */
export async function cancel(requestId) {
  cancelled.add(requestId);
  if (cancelled.size > 500) cancelled.delete(cancelled.values().next().value);
  if (await chrome.offscreen.hasDocument()) await send({ type: MSG.MODEL_CANCEL, requestId });
}

/** モデルの状態。見えないページが無ければ何も読み込んでいない。 */
export async function status() {
  if (!(await chrome.offscreen.hasDocument())) return { loaded: null };
  return (await send({ type: MSG.MODEL_STATUS })) ?? { loaded: null };
}

/** モデルを解放する。見えないページごと閉じるので、WASM・WebGPU のメモリーもすべて返る。 */
export async function unload() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
}
