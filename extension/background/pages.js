// ページへの差し込みと、ページの翻訳の操作。同じサイト内で移ったページの自動翻訳、テキスト翻訳のページを開く操作もここに置く。

import { MSG } from '../shared/messages.js';
import { pageReadable, siteOf } from '../shared/text.js';
import { settings } from './config.js';

/**
 * ページへ部品を差し込む。page/loader.js がページ側のモジュール（page/main.js）を読み込み、読み込み終わるまで待つ
 * （差し込んだ直後に送るメッセージを取りこぼさないため）。二重に差し込んでも、ページ側で1回だけ読み込む。
 */
export async function inject(tabId, frameId) {
  const target = frameId ? { tabId, frameIds: [frameId] } : { tabId };
  await chrome.scripting.insertCSS({ target, files: ['shared/theme.css', 'page/page.css'] });
  await chrome.scripting.executeScript({ target, files: ['page/loader.js'] });
}

/** 差し込んでからメッセージを送る。 */
export async function sendToPage(tabId, message, frameId = 0) {
  await inject(tabId, frameId);
  return chrome.tabs.sendMessage(tabId, message, { frameId });
}

/**
 * ページの翻訳・表示の切り替え。action：'toggle'（訳す／原文⇄訳文）・'trans'・'orig'・'both'・'stop'（やめて元に戻す）。
 * 内蔵ビューアで表示している文書（PDF など）はページを訳せないので、テキスト翻訳を開く（Alt+T を押して何も起きないのを避ける）。
 */
export async function pageAction(tabId, action) {
  if (await isViewer(tabId)) return openTextPage();
  if (action === 'stop') return sendToPage(tabId, { type: MSG.STOP });
  if (action === 'toggle') return sendToPage(tabId, { type: MSG.TOGGLE, mode: (await settings()).mode });
  return sendToPage(tabId, { type: MSG.START, mode: action });
}

/** モデルを切り替える。開いているタブを訳していたら、新しいモデルで訳し直す（比べられるように）。 */
export async function switchModel(model, tabId) {
  await chrome.storage.sync.set({ model });
  if (tabId) chrome.tabs.sendMessage(tabId, { type: MSG.RETRANSLATE, model }).catch(() => {});
}

/**
 * テキスト翻訳のページを開く。開いていればそのタブへ移る。
 * text を渡すと、その文章を入れて訳す（選択範囲の訳の吹き出しから）。文章は URL に載せず storage.session で渡す。
 */
export async function openTextPage(text) {
  if (text) await chrome.storage.session.set({ pendingText: text });
  const url = chrome.runtime.getURL('ui/translate.html');
  const [open] = await chrome.tabs.query({ url });
  if (open?.id) {
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
    if (text) chrome.tabs.sendMessage(open.id, { type: MSG.TAKE_TEXT }).catch(() => {});
  } else {
    await chrome.tabs.create({ url });
  }
}

/** 訳し終えていない段落の数をボタンに出す。0 なら消す。 */
export function setBadge(tabId, pending) {
  if (tabId == null) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#C23B22' });
  chrome.action.setBadgeText({ tabId, text: pending > 0 ? String(Math.min(pending, 999)) : '' });
}

// ---------------- 内蔵ビューアで表示している文書 ----------------
// PDF などはブラウザーの内蔵ビューアが表示し、拡張機能はその中へ差し込めない（shared/text.js の pageReadable）。
// いちばん外側の枠の page/watch.js が知らせる文書の種類を、タブごとに storage.session へ覚える（Service Workerが止まっても残す）。
// 知らせが来ないページ（file:// など）は普通のページとして扱い、差し込みに失敗したときの戻り道（menus.js）で受ける。

const viewerKey = (tabId) => 'viewer:' + tabId;

/** タブで開いている文書の種類を覚える。いちばん外側の枠だけを見る。 */
export async function rememberDocument(tabId, frameId, contentType) {
  if (tabId == null || frameId !== 0) return;
  if (pageReadable(contentType)) await chrome.storage.session.remove(viewerKey(tabId));
  else await chrome.storage.session.set({ [viewerKey(tabId)]: true });
}

/** タブが内蔵ビューアで表示している文書（PDF など）か。 */
export async function isViewer(tabId) {
  if (tabId == null) return false;
  return !!(await chrome.storage.session.get(viewerKey(tabId)))[viewerKey(tabId)];
}

// ---------------- 同じサイト内の移動で自動で訳す ----------------
// ページを訳したタブでは、同じサイト（github.com と docs.github.com のように末尾が同じドメイン）のページへ移ったら、
// 移動先も同じ表示で訳す。原文表示に戻す・翻訳をやめる・別のサイトへ移ると止める。タブごとに storage.session へ覚える。
// 移動先のページが読み込まれたことは、すべてのページに入る page/watch.js が知らせる。
// GitHub のようにページを読み直さずに中身を入れ替えるサイトでは、ページ側が書き換えを見て続けて訳す。

const autoKey = (tabId) => 'auto:' + tabId;

/** ページの表示（trans・both・orig）を覚える。いちばん外側の枠だけを見る。 */
export async function rememberPageState(tabId, frameId, host, mode) {
  if (tabId == null || frameId !== 0) return;
  if (mode === 'orig' || !host) await chrome.storage.session.remove(autoKey(tabId));
  else await chrome.storage.session.set({ [autoKey(tabId)]: { site: siteOf(host), mode } });
}

/** ページが読み込まれた：訳していたタブで同じサイトなら続けて訳す。 */
export async function onPageLoaded(tabId, frameId, host) {
  if (tabId == null || frameId !== 0) return;
  const auto = (await chrome.storage.session.get(autoKey(tabId)))[autoKey(tabId)];
  if (!auto) return;
  if (siteOf(host) !== auto.site) {
    await chrome.storage.session.remove(autoKey(tabId)); // 別のサイトへ移ったら止める
    return;
  }
  await sendToPage(tabId, { type: MSG.START, mode: auto.mode });
}

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove([autoKey(tabId), viewerKey(tabId)]));
