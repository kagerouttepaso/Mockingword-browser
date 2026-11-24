import { themeCss } from '../shared/theme.js';
// 訳しているページの上部に固定するバー。進み具合（残りの段落・送信中の同時実行数と待ち時間・モデルの準備）と、
// 訳文・原文・対訳の切り替えを出す。× は翻訳をやめて元のページに戻す。
// ページの見た目の影響を受けないよう、閉じた Shadow DOM の中に作る。body の外（html 直下）に置くので、段落の収集や
// 書き換えの監視にも入らない。操作の中身（表示の切り替え・ページ全体・終了）は page/main.js が init で渡す。

import { alive, state, tokensPerSecond } from './state.js';

const bar = { host: null, status: null, progress: null, buttons: {}, whole: null, message: null, error: false, done: '', actions: null };

/** 操作の中身を受け取る。{ onMode(mode), onWhole(), onClose() } */
export function initBar(actions) {
  bar.actions = actions;
}

const STYLE = `${themeCss}
  :host { all: initial; }
  .bar {
    position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
    display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 24px); box-sizing: border-box;
    padding: 6px 8px 6px 16px; border-radius: 999px;
    font: 13px/1.4 "Yu Gothic UI", "Meiryo UI", system-ui, sans-serif;
    color: var(--mw-on-surface); background: var(--mw-surface-container-low); border: 1px solid var(--mw-outline-variant);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);
    overflow: hidden;
  }
  /* 進み具合の細い線（訳し終えた段落の割合）。訳している間だけ出す。 */
  .progress {
    position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: var(--mw-primary);
    transition: width 0.4s ease-out, opacity 0.4s;
  }
  .progress.idle { opacity: 0; }
  .name { font-weight: bold; color: var(--mw-on-surface); }
  .status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .status.error { color: #cf222e; }
  .group { display: flex; border: 1px solid var(--mw-outline-variant); border-radius: 999px; overflow: hidden; flex: none; }
  button { all: unset; cursor: pointer; padding: 5px 11px; font: inherit; color: inherit; flex: none; }
  .group button + button { border-left: 1px solid var(--mw-outline-variant); }
  button:hover { background: color-mix(in srgb,var(--mw-on-surface-variant) 8%,transparent); }
  button:focus-visible { outline: 2px solid var(--mw-primary); outline-offset: 1px; }
  .whole { color: var(--mw-primary); }
  button.on { background: var(--mw-primary); color: var(--mw-on-primary); }
  .close { border-radius: 999px; padding: 2px 8px; color: var(--mw-on-surface-variant); }
  @media (prefers-color-scheme: dark) {
    .bar { color: var(--mw-on-surface); background: var(--mw-surface-container-low); border-color: var(--mw-outline-variant); }
    .group, .group button + button { border-color: var(--mw-outline-variant); }
    .name { color: var(--mw-on-surface); }
    .close { color: var(--mw-on-surface-variant); }
  }`;

function ensureBar() {
  if (bar.host?.isConnected) return;
  const host = document.createElement('div');
  // 要素には page.css の .plamo-ui（枠・影）を当てない。見た目はすべて Shadow DOM の中で決める。
  host.className = 'plamo-ui-host';
  host.dataset.mwTheme = globalThis.__mockingwordTheme ?? 'system';
  host.style.cssText = 'all: initial !important;';
  host.setAttribute('translate', 'no');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${STYLE}</style>
    <div class="bar" role="toolbar" aria-label="Mockingword">
      <img src="${chrome.runtime.getURL('icons/icon32.png')}" alt="" style="width:28px;height:28px;flex:none"><span class="name">Mocking<span style="color:var(--mw-primary)">word</span></span>
      <span class="status"></span>
      <span class="group">
        <button data-mode="trans" title="訳文だけを表示">訳文</button>
        <button data-mode="orig" title="原文を表示">原文</button>
        <button data-mode="both" title="原文の下に訳文を表示">対訳</button>
      </span>
      <button class="whole" title="ページ全体を訳す">ページ全体を訳す</button>
      <button class="close" title="翻訳をやめて元のページに戻す">×</button>
      <span class="progress idle"></span>
    </div>`;
  bar.status = root.querySelector('.status');
  bar.progress = root.querySelector('.progress');
  for (const b of root.querySelectorAll('[data-mode]')) {
    bar.buttons[b.dataset.mode] = b;
    b.onclick = () => bar.actions.onMode(b.dataset.mode);
  }
  bar.whole = root.querySelector('.whole');
  bar.whole.onclick = () => bar.actions.onWhole();
  root.querySelector('.close').onclick = () => bar.actions.onClose();
  document.documentElement.appendChild(host);
  bar.host = host;
  // 待っている秒数を出し直す。バーを外したら止める。
  const tick = setInterval(() => (host.isConnected && alive() ? state.chunks.size && updateBar() : clearInterval(tick)), 1000);
}

export function showBar() {
  ensureBar();
  updateBar();
}

export function barShown() {
  return !!bar.host?.isConnected;
}

/** バーを外し、知らせと「訳し終えました」を消す（翻訳をやめたとき）。 */
export function removeBar() {
  bar.done = '';
  bar.message = null;
  bar.error = false;
  bar.host?.remove();
}

/** 返事を待っている同時実行数と、いちばん長く待っている秒数（何を待っているかを見えるようにする）。 */
function waiting() {
  if (state.chunks.size === 0) return '';
  const oldest = Math.min(...[...state.chunks.values()].map((c) => c.t));
  const tps = tokensPerSecond();
  return `（送信中 ${state.chunks.size}件・最長 ${Math.round((performance.now() - oldest) / 1000)}秒${tps ? `・${tps} tok/s` : ''}）`;
}

/** バーの表示を今の状態に合わせる。外しているときは何もしない。 */
export function updateBar() {
  if (!bar.host?.isConnected) return;
  let text;
  if (bar.message) text = bar.message;
  else if (state.halted) text = '止まっています（訳文・対訳を押すともう一度試します）';
  else if (state.pending.size > 0) text = `訳しています… 残り ${state.pending.size} 段落${waiting()}`;
  else if (state.chunks.size > 0 || state.looking > 0) text = `訳しています…${waiting()}`;
  else text = bar.done || '訳し終えました';
  if (state.model && !bar.message) text += `（${state.model}）`;
  bar.status.textContent = text;
  bar.status.classList.toggle('error', bar.error);
  for (const [mode, b] of Object.entries(bar.buttons)) b.classList.toggle('on', mode === state.mode);
  // 進み具合：訳し終えた段落 ÷（訳し終えた＋待っている＋送って返事を待っている段落）。
  let sending = 0;
  for (const c of state.chunks.values()) sending += c.paras.filter((p) => p.translation == null).length;
  const total = state.translated + state.pending.size + sending + state.looking;
  const busy = state.pending.size + sending + state.looking > 0;
  bar.progress.classList.toggle('idle', !busy);
  if (total) bar.progress.style.width = `${Math.round((state.translated / total) * 100)}%`;
  bar.whole.style.display = state.started ? 'none' : '';
}

/** モデルの準備などの一時的な知らせ。null で消す。error なら赤で出す。 */
export function barMessage(text, error = false) {
  bar.message = text;
  bar.error = error;
  updateBar();
}

/** 知らせているのが失敗か（成功の返事が来たら消すため）。 */
export function barHasError() {
  return bar.error;
}

/** 知らせが進み具合（失敗でない）なら消す。 */
export function clearBarNotice() {
  if (bar.message && !bar.error) barMessage(null);
}

/** 「訳し終えました」の文を決める（最初のページ全体を訳し終えたとき）。 */
export function setBarDone(text) {
  bar.done = text;
  updateBar();
}
