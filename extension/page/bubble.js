// 選択範囲の訳を出す吹き出しと、右下の通知。設計は docs/05_選択範囲とテキスト翻訳.md。

import { MSG } from '../shared/messages.js';
import { barMessage, barShown, clearBarNotice } from './bar.js';
import { notify, send } from './state.js';

let bubble = null;

function closeBubble() {
  bubble?.remove();
  bubble = null;
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeBubble());
document.addEventListener('mousedown', (e) => bubble && !bubble.contains(e.target) && closeBubble());

/**
 * 選択範囲（無ければ fallbackText）の訳を、選択範囲のすぐ下の吹き出しに出す。
 * 吹き出しの「テキスト翻訳で開く」で、選んだ文章を入れたテキスト翻訳のページを開く。
 */
export async function translateSelection(fallbackText) {
  const selection = window.getSelection();
  const text = (selection?.toString() || fallbackText).trim();
  if (!text) return;
  const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
  closeBubble();
  const el = (bubble = document.createElement('div'));
  el.className = 'plamo-ui plamo-bubble';
  el.dataset.mwTheme = globalThis.__mockingwordTheme ?? 'system';
  el.setAttribute('translate', 'no');
  el.lang = 'ja';
  el.textContent = '翻訳中…';
  document.body.appendChild(el);
  const top = rect && rect.height ? rect.bottom + 8 : 16;
  const left = rect && rect.width ? rect.left : 16;
  el.style.top = Math.min(top, window.innerHeight - 80) + 'px';
  el.style.left = Math.max(8, Math.min(left, window.innerWidth - 440)) + 'px';
  const t0 = performance.now();
  const response = await send({ type: MSG.TRANSLATE_ONE, text }).catch((e) => ({ ok: false, error: e.message }));
  clearNotice();
  if (bubble !== el) return; // 待つ間に閉じた・別の吹き出しを出した
  el.textContent = '';
  const body = document.createElement('div');
  body.className = 'plamo-bubble-text';
  body.textContent = response?.ok ? response.text : response?.error ?? '翻訳に失敗しました。';
  const foot = document.createElement('div');
  foot.className = 'plamo-bubble-foot';
  foot.textContent = response?.ok ? `PLaMo ${response.model}・${((performance.now() - t0) / 1000).toFixed(1)}秒　` : '';
  const open = document.createElement('a');
  open.className = 'plamo-bubble-link';
  open.href = '#';
  open.textContent = 'テキスト翻訳で開く';
  open.onclick = (e) => {
    e.preventDefault();
    notify({ type: MSG.OPEN_TEXT_WITH, text });
    closeBubble();
  };
  foot.append(open);
  el.append(body, foot);
}

/** 右下に数秒だけ出す通知。 */
export function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'plamo-ui plamo-toast' + (isError ? ' plamo-toast-error' : '');
  el.dataset.mwTheme = globalThis.__mockingwordTheme ?? 'system';
  el.setAttribute('translate', 'no');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 10000 : 5000);
}

/** モデルを準備している間の進み具合。ページを訳しているならバーに、選択範囲の翻訳だけのときは右下に出す。 */
let noticeEl = null;
export function notice(text) {
  if (barShown()) return barMessage(text);
  if (!noticeEl) {
    noticeEl = document.createElement('div');
    noticeEl.className = 'plamo-ui plamo-toast';
    noticeEl.dataset.mwTheme = globalThis.__mockingwordTheme ?? 'system';
    noticeEl.setAttribute('translate', 'no');
    document.body.appendChild(noticeEl);
  }
  noticeEl.textContent = text;
}

export function clearNotice() {
  clearBarNotice();
  noticeEl?.remove();
  noticeEl = null;
}
