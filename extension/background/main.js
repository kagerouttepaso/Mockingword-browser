// 拡張機能のService Workerの入口。起動時の準備と、ほかの部品からのメッセージの振り分けだけを行う。
// 部品の全体像とメッセージの流れは docs/02_アーキテクチャ.md。

import { LOG_SOURCE, LOG_TAG, MSG, OFFSCREEN } from '../shared/messages.js';
import { CancelledError, cancel, forget, status, streamPartial, unload } from '../core/engine.js';
import { lookupCached, translateBatch, translateLines, translateText } from '../core/translator.js';
import { clear as clearCache, stats as cacheStats } from '../core/cache.js';
import { migrate, settings } from './config.js';
import { addLog, clearLogs, logs } from './logs.js';
import { lastUse, markUse, startIdleCheck } from './idle.js';
import { buildMenus, fitMenus } from './menus.js';
import { autoTune, speedTest, stopTune, tuning } from './tune.js';
import { isPdf, isViewer, onPageLoaded, openTextPage, pageAction, rememberDocument, rememberPageState, sendToPage, setBadge, switchModel } from './pages.js';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await migrate(reason);
  await setUp();
});
chrome.runtime.onStartup.addListener(setUp);

async function setUp() {
  await buildMenus();
  startIdleCheck();
}

// ショートカット（Alt+T）：未翻訳なら訳す、訳した後は原文⇄訳文を切り替える。
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'translate-page' && tab?.id) await pageAction(tab.id, 'toggle');
});

/** 直近に翻訳を頼んだタブ。モデルの準備の進み具合を、そのタブに出す。 */
let lastTabId = null;
function noticeToTab(text) {
  if (lastTabId != null) chrome.tabs.sendMessage(lastTabId, { type: MSG.NOTICE, text }).catch(() => {});
}

/** ページのバッチの番号（タブ・枠・バッチ）。取り消しで同じ番号を作る。 */
const requestIdOf = (sender, id) => `page:${sender.tab?.id}:${sender.frameId}:${id}`;

/** 訳しているページのバッチのリクエスト番号（取り消しを、訳している間だけ効かせる）。 */
const batches = new Set();

/** メッセージの種類ごとの受け持ち。返した値をそのまま返事にする。 */
const handlers = {
  async [MSG.TRANSLATE_BATCH](message, sender, options) {
    lastTabId = sender.tab?.id ?? lastTabId;
    await markUse();
    options.requestId = requestIdOf(sender, message.id);
    const t0 = Date.now();
    batches.add(options.requestId);
    try {
      const r = await translateBatch(message.texts, options);
      addLog(LOG_SOURCE.background, '完了', { requestId: options.requestId, ms: Date.now() - t0, requests: r.stats.requests, fallback: r.stats.fallback });
      await markUse();
      return { ok: true, model: options.model, ...r };
    } catch (e) {
      if (!(e instanceof CancelledError)) throw e;
      addLog(LOG_SOURCE.background, '取り消し済み', { requestId: options.requestId, ms: Date.now() - t0 });
      return { ok: false, cancelled: true };
    } finally {
      batches.delete(options.requestId);
      forget(options.requestId); // 番号はページごとに1から振り直すので、次のページの同じ番号を取り消さない
    }
  },
  async [MSG.TRANSLATE_ONE](message, sender, options) {
    lastTabId = sender.tab?.id ?? lastTabId;
    await markUse();
    // テキスト翻訳のページは原文と訳文の言語を自分で選び、行ごとに訳す（lines）。ほかは日本語へ訳す。
    if (message.source !== undefined) options.source = message.source || null;
    if (message.target) options.target = message.target;
    // stream：テキスト翻訳のページへ、訳文の途中と生成したトークン数を0.1秒おきに知らせる（待たずに読めるように）。
    // 速さは最初のトークンからの時間で割る（モデルの読み込み・原文の読み込みの待ちを入れない）。
    let tokens = 0;
    let firstAt = 0;
    if (message.stream && message.lines) {
      let last = 0;
      options.onTokens = (n) => {
        tokens += n;
        firstAt ||= Date.now();
      };
      options.onUpdate = (text) => {
        if (Date.now() - last < 100) return;
        last = Date.now();
        chrome.runtime.sendMessage({ type: MSG.TEXT_PARTIAL, stream: message.stream, text, tokens, genMs: firstAt ? last - firstAt : 0 }).catch(() => {});
      };
    }
    const text = message.lines ? await translateLines(message.text, options) : await translateText(message.text, options);
    await markUse();
    return { ok: true, model: options.model, text, tokens, genMs: firstAt ? Date.now() - firstAt : 0 };
  },
  async [MSG.CACHE_LOOKUP](message, _sender, options) {
    const results = await lookupCached(message.texts, options);
    addLog(LOG_SOURCE.background, 'キャッシュ', { asked: message.texts.length, hits: results.filter((r) => r !== null).length });
    return { ok: true, results, model: options.model };
  },
  async [MSG.CANCEL](message, sender) {
    // 訳しているリクエストだけを取り消す。返事の後に届いた取り消しを覚えると、次のページの同じ番号を取り消してしまう。
    const id = requestIdOf(sender, message.id);
    if (batches.has(id)) await cancel(id);
    return { ok: true };
  },
  async [MSG.CACHE_STATS]() {
    return { ok: true, ...(await cacheStats()) };
  },
  async [MSG.CACHE_CLEAR]() {
    await clearCache();
    return { ok: true };
  },
  async [MSG.LOG](message, sender) {
    addLog(message.source ?? LOG_SOURCE.page, message.event, { ...message.data, tab: sender.tab?.id });
    return { ok: true };
  },
  async [MSG.LOGS_GET]() {
    return { ok: true, logs };
  },
  async [MSG.LOGS_CLEAR]() {
    clearLogs();
    return { ok: true };
  },
  async [MSG.STATUS](_message, _sender, options) {
    return { ok: true, ...(await status()), model: options.model, idleMinutes: options.idleMinutes, lastUse: await lastUse() };
  },
  async [MSG.UNLOAD]() {
    if (tuning()) return { ok: false, error: '速さの調整の途中です。' };
    await unload();
    return { ok: true };
  },
  async [MSG.SPEED_TEST](_message, _sender, options) {
    return speedTest(options);
  },
  async [MSG.TUNE](_message, _sender, options) {
    return autoTune(options);
  },
  async [MSG.TUNE_STOP]() {
    stopTune();
    return { ok: true };
  },
  async [MSG.PAGE_ACTION](message) {
    await pageAction(message.tabId, message.action);
    return { ok: true };
  },
  async [MSG.SWITCH_MODEL](message) {
    await switchModel(message.model, message.tabId);
    return { ok: true };
  },
  async [MSG.OPEN_TEXT]() {
    await openTextPage();
    return { ok: true };
  },
  async [MSG.OPEN_TEXT_WITH](message) {
    await openTextPage(message.text);
    return { ok: true };
  },
  async [MSG.PAGE_KIND](message) {
    return { viewer: await isViewer(message.tabId), pdf: await isPdf(message.tabId) };
  },
  async [MSG.PAGE_STATE](message, sender) {
    await rememberPageState(sender.tab?.id, sender.frameId, message.host, message.mode);
    return { ok: true };
  },
  async [MSG.PAGE_LOADED](message, sender) {
    await rememberDocument(sender.tab?.id, sender.frameId, message.contentType);
    if (sender.tab?.active && sender.frameId === 0) await fitMenus(sender.tab.id);
    if (await isViewer(sender.tab?.id)) return { ok: true }; // 内蔵ビューアの文書は自動で訳さない（訳せない）
    await onPageLoaded(sender.tab?.id, sender.frameId, message.host);
    return { ok: true };
  },
  async [MSG.SELECTION_ICON](message, sender) {
    // 選択範囲の「訳」アイコンを押した：その枠へ部品を差し込み、選択範囲の訳を吹き出しで出す。
    if (sender.tab?.id == null) return { ok: false };
    await sendToPage(sender.tab.id, { type: MSG.TRANSLATE_SELECTION, text: message.text }, sender.frameId ?? 0);
    return { ok: true };
  },
  async [MSG.PROGRESS](message, sender) {
    setBadge(sender.tab?.id, message.pending);
    return { ok: true };
  },
  async [MSG.PARTIAL](message) {
    if (streamPartial(message)) return { ok: true }; // テキスト翻訳の途中（core/engine.js）
    // Offscreen Documentで切り出した行を、ページのバッチの行へ戻して渡す。
    const rows = message.pageRows;
    const m = /^page:(\d+):(\d+):(\d+)$/.exec(message.requestId ?? '');
    if (!rows || !m || !batches.has(message.requestId)) return { ok: true };
    const snapshot = message.text.split('\n');
    const lines = snapshot.slice(0, rows.length).map((text, k) => ({ i: rows[k], text, complete: k < snapshot.length - 1 }));
    chrome.tabs.sendMessage(Number(m[1]), { type: MSG.SHOW_PARTIAL, id: Number(m[3]), lines }, { frameId: Number(m[2]) }).catch(() => {});
    return { ok: true };
  },
  async [MSG.MODEL_PROGRESS](message) {
    const pct = Math.floor((message.loaded / message.total) * 100);
    const mb = Math.round(message.total / 1e6);
    noticeToTab(pct < 100
      ? `翻訳モデル（${message.model}、約${mb}MB）を準備しています… ${pct}%（初回だけダウンロードします）`
      : `翻訳モデル（${message.model}）を読み込んでいます…`);
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Offscreen Document宛てのメッセージは、そちらが答える。ここで答えると、そちらの返事より先に届いてしまう。
  if (message?.target === OFFSCREEN) return false;
  const handler = handlers[message?.type];
  if (!handler) return false;
  settings()
    .then((options) => handler(message, sender, options))
    .then(sendResponse)
    .catch((e) => {
      console.error(`${LOG_TAG} Service Worker で失敗`, message.type, e?.stack ?? e);
      sendResponse({ ok: false, error: e.message });
    });
  return true; // 非同期で答える
});
