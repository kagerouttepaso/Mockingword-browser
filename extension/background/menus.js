// 右クリックのメニュー。項目が2つ以上ある場面では、ブラウザーが拡張機能の名前の下にまとめる。
// - 文章を選んで右クリック：選択範囲の訳を吹き出しで出す／選択した段落を訳文に置き換える
// - 範囲を選ばずに右クリック：ページ全体を訳す（段落だけ訳すときは、範囲を選んでから右クリックする。2026-11-09、作者の指示）
// - ツールバーのボタンの右クリック：テキスト翻訳を開く／モデルを解放する
// 訳文・原文・対訳の切り替えは、訳しているページの上部のバーで行う。

import { MSG } from '../shared/messages.js';
import { unload } from '../core/engine.js';
import { settings } from './config.js';
import { openTextPage, sendToPage } from './pages.js';

export async function buildMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'selection', title: '選択範囲を日本語に訳す', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'selected-paragraphs', title: '選択した段落を日本語に訳す', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'page', title: 'このページを日本語に訳す', contexts: ['page'] });
  chrome.contextMenus.create({ id: 'open-text', title: 'テキスト翻訳を開く', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'unload', title: 'モデルを解放してメモリーを空ける', contexts: ['action'] });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId);
  if (id === 'open-text') return openTextPage();
  if (id === 'unload') return unload();
  if (!tab?.id) return;
  // 右クリックした場所が枠（iframe）の中なら、その枠へ差し込む。
  const frameId = info.frameId ?? 0;
  const { mode } = await settings();
  switch (id) {
    case 'selection':
      return sendToPage(tab.id, { type: MSG.TRANSLATE_SELECTION, text: info.selectionText ?? '' }, frameId);
    case 'selected-paragraphs':
      return sendToPage(tab.id, { type: MSG.TRANSLATE_SELECTED_PARAGRAPHS, mode }, frameId);
    case 'page':
      return sendToPage(tab.id, { type: MSG.START, mode });
  }
});
