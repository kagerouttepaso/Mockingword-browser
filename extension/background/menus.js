// 右クリックのメニュー。項目が2つ以上ある場面では、ブラウザーが拡張機能の名前の下にまとめる。
// - 文章を選んで右クリック：選択範囲の訳を吹き出しで出す／選択した段落を訳文に置き換える
// - 範囲を選ばずに右クリック：ページ全体を訳す（段落だけ訳すときは、範囲を選んでから右クリックする。2026-11-09、作者の指示）
// - ツールバーのボタンの右クリック：テキスト翻訳を開く／モデルを解放する
// 訳文・原文・対訳の切り替えは、訳しているページの上部のバーで行う。
//
// 項目の名前には設定の訳文の言語を入れる（「選択範囲を英語に訳す」）。設定を変えたら作り直す。
//
// 内蔵ビューアで表示している文書（PDF など）では、ページ側の部品を差し込めない。そこでは「選択範囲を…に訳す」だけを出し
// （1項目なので拡張機能の名前の下にまとめず、メニューの1段目に出る。2026-11-16、作者の希望）、選んだ文章をテキスト翻訳で訳す。
// メニューの出し分けはタブごとに変えられないので、前面のタブが変わるたびに項目を作り直す（fitMenus）。
// visible: false で隠すだけでは、ブラウザーが隠した項目も数えて拡張機能の名前の下にまとめる（2026-11-16、Brave で作者が確認）ので、取り除く。

import { MSG } from '../shared/messages.js';
import { unload } from '../core/engine.js';
import { languageLabel, pdfFontOf } from '../shared/languages.js';
import { settings } from './config.js';
import { isPdf, isViewer, openPdfPage, openTextPage, sendToPage } from './pages.js';

/**
 * 項目の名前に入れる訳文の言語。Service Workerは止まるたびに変数を失うので、項目を作るたびに設定から読む。
 * PDF は、PDF に書けない言語なら PDF翻訳のページの既定（日本語）で訳す。
 */
async function labels() {
  const { target } = await settings();
  return { label: languageLabel(target), pdfLabel: languageLabel(pdfFontOf(target) ? target : 'ja') };
}

/** ページ側の部品が要る項目。内蔵ビューアの文書では取り除く。 */
const pageOnly = ({ label }) => [
  { id: 'selected-paragraphs', title: `選択した段落を${label}に訳す`, contexts: ['selection'] },
  { id: 'page', title: `このページを${label}に訳す`, contexts: ['page'] },
];

/** 内蔵ビューアで PDF を表示しているときだけの項目。範囲を選ばずに右クリックすると、PDF翻訳のページで開き直す（docs/12_PDFの翻訳.md）。 */
const pdfOnly = ({ pdfLabel }) => [{ id: 'pdf', title: `このPDFを${pdfLabel}に訳す`, contexts: ['page'] }];

/** 項目を作る。同じ id がもうあれば何もしない（create はエラーを lastError で返すので、読んで捨てる）。 */
const create = (item) => new Promise((resolve) => chrome.contextMenus.create(item, () => resolve(void chrome.runtime.lastError)));

export async function buildMenus() {
  const { label } = await labels();
  await chrome.contextMenus.removeAll();
  await create({ id: 'selection', title: `選択範囲を${label}に訳す`, contexts: ['selection'] });
  await create({ id: 'open-text', title: 'テキスト翻訳を開く', contexts: ['action'] });
  await create({ id: 'open-pdf', title: 'PDFファイルを開いて訳す', contexts: ['action'] });
  await create({ id: 'unload', title: 'モデルを解放してメモリーを空ける', contexts: ['action'] });
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  await fitMenus(tab?.id);
}

/** 前面のタブの文書に合わせて、ページ側の部品が要る項目を作る・取り除く。 */
export async function fitMenus(tabId) {
  const remove = (items) => Promise.all(items.map(({ id }) => chrome.contextMenus.remove(id).catch(() => {})));
  const names = await labels();
  if (await isViewer(tabId)) await remove(pageOnly(names));
  else for (const item of pageOnly(names)) await create(item);
  if (await isPdf(tabId)) for (const item of pdfOnly(names)) await create(item);
  else await remove(pdfOnly(names));
}

// 訳文の言語を変えたら、項目の名前を作り直す。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.target) buildMenus();
});

chrome.tabs.onActivated.addListener(({ tabId }) => fitMenus(tabId));
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab?.id != null) await fitMenus(tab.id);
});

/** 選んだ文章をテキスト翻訳で訳す。ページへ差し込めないとき（内蔵ビューア・file:// など）の訳し方。 */
const toTextPage = (info) => openTextPage(info.selectionText ?? '');

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  if (id === 'open-text') return openTextPage();
  if (id === 'open-pdf') return chrome.tabs.create({ url: chrome.runtime.getURL('ui/pdf.html') });
  if (id === 'unload') return unload();
  if (!tab?.id) return;
  // 右クリックした場所が枠（iframe）の中なら、その枠へ差し込む。
  const frameId = info.frameId ?? 0;
  const { mode, target } = await settings();
  switch (id) {
    case 'selection':
      if (await isViewer(tab.id)) return toTextPage(info);
      return sendToPage(tab.id, { type: MSG.TRANSLATE_SELECTION, text: info.selectionText ?? '' }, frameId).catch(() => toTextPage(info));
    case 'selected-paragraphs':
      return sendToPage(tab.id, { type: MSG.TRANSLATE_SELECTED_PARAGRAPHS, mode, target }, frameId).catch(() => toTextPage(info));
    case 'page':
      return sendToPage(tab.id, { type: MSG.START, mode, target });
    case 'pdf':
      return openPdfPage(tab.id);
  }
});
