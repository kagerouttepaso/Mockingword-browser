import { themeCss } from '../shared/theme.js';
// 訳しているページの右端に配置するドック型の翻訳バー。
// 翻訳中・エラー時・操作中だけ左へ展開し、完了後は一定時間で右端の小さなアイコンへ自動で畳むことで、
// ページ上部のナビゲーションメニューや本文を覆い隠さないようにする。
// つまみ（アイコン部分）を上下にドラッグして位置を避けられる。× は翻訳をやめて元のページに戻す。
// ページの見た目の影響を受けないよう、閉じた Shadow DOM の中に作り、html 直下に置く。

import { alive, state, tokensPerSecond } from './state.js';

const AUTO_COLLAPSE_MS = 3500;
const LEAVE_COLLAPSE_MS = 550;
const MARGIN_Y = 12;
const DEFAULT_BOTTOM = 20;

const bar = {
  host: null,
  el: null,
  handle: null,
  dot: null,
  status: null,
  progress: null,
  buttons: {},
  whole: null,
  message: null,
  error: false,
  done: '',
  actions: null,
  collapsed: false,
  hovering: false,
  focusWithin: false,
  dragging: false,
  pinnedClosed: false,
  collapseTimer: null,
  topY: null,
  customTop: false,
};

/** 操作の中身を受け取る。{ onMode(mode), onWhole(), onClose() } */
export function initBar(actions) {
  bar.actions = actions;
}

const STYLE = `${themeCss}
  :host { all: initial; }
  .bar {
    position: fixed; right: 0; top: 0; z-index: 2147483647;
    display: flex; align-items: center; max-width: calc(100vw - 12px); box-sizing: border-box;
    border-radius: 999px 0 0 999px;
    font: 13px/1.4 "Yu Gothic UI", "Meiryo UI", system-ui, sans-serif;
    color: var(--mw-on-surface); background: var(--mw-surface-container-low);
    border: 1px solid var(--mw-outline-variant); border-right: none;
    box-shadow: -2px 4px 16px rgba(0, 0, 0, 0.16);
    overflow: hidden;
    transition: opacity 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
    user-select: none;
  }
  .bar.collapsed {
    opacity: 0.88;
    box-shadow: -1px 2px 10px rgba(0, 0, 0, 0.14);
  }
  .bar.collapsed:hover, .bar.dragging {
    opacity: 1;
    box-shadow: -2px 4px 16px rgba(0, 0, 0, 0.2);
  }
  /* 展開パネル：CSS Grid の 0fr → 1fr で中身の実幅に合わせて滑らかに開閉する。 */
  .tray-wrap {
    display: grid; grid-template-columns: 1fr;
    transition: grid-template-columns 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.18s ease;
    min-width: 0;
  }
  .bar.collapsed .tray-wrap {
    grid-template-columns: 0fr;
    opacity: 0;
    pointer-events: none;
  }
  .tray {
    display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden;
    padding: 6px 4px 6px 14px;
    transition: padding 0.22s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .bar.collapsed .tray {
    padding-left: 0; padding-right: 0;
  }
  /* 右端のつまみ（常に表示）。ドラッグで上下移動、ホバー・クリックで開閉。 */
  .handle {
    all: unset; position: relative; display: flex; align-items: center; justify-content: center;
    padding: 6px 10px 6px 9px; flex: none; cursor: grab; touch-action: none;
  }
  .handle::before {
    content: ""; position: absolute; left: 0; top: 20%; bottom: 20%; width: 1px;
    background: var(--mw-outline-variant); transition: opacity 0.18s ease;
  }
  .bar.collapsed .handle::before { opacity: 0; }
  .bar.dragging .handle { cursor: grabbing; }
  .handle:focus-visible { outline: 2px solid var(--mw-primary); outline-offset: -2px; border-radius: 999px 0 0 999px; }
  .icon-ring {
    position: relative; display: flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; border-radius: 50%;
    border: 1.5px solid var(--mw-primary); box-sizing: border-box;
    background: var(--mw-surface-container-lowest);
  }
  .icon-ring img { width: 24px; height: 24px; display: block; pointer-events: none; border-radius: 50%; }
  /* 現在の状態を示す小さな点（訳文/対訳：主の色、原文：グレー、エラー：赤）。 */
  .dot {
    position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px; border-radius: 50%;
    background: var(--mw-primary); border: 1.5px solid var(--mw-surface-container-low); box-sizing: border-box;
  }
  .dot.orig { background: var(--mw-outline); }
  .dot.error { background: #cf222e; }
  /* 進み具合の細い線（訳し終えた段落の割合）。訳している間だけ出す。 */
  .progress {
    position: absolute; left: 0; bottom: 0; height: 2px; width: 0; background: var(--mw-primary);
    transition: width 0.4s ease-out, opacity 0.4s;
    pointer-events: none;
  }
  .progress.idle { opacity: 0; }
  .name { font-weight: bold; color: var(--mw-on-surface); white-space: nowrap; flex: none; }
  .status { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; max-width: 48vw; }
  .status.error { color: #cf222e; }
  .group { display: flex; border: 1px solid var(--mw-outline-variant); border-radius: 999px; overflow: hidden; flex: none; }
  .tray button { all: unset; cursor: pointer; padding: 5px 11px; font: inherit; color: inherit; flex: none; white-space: nowrap; }
  .group button + button { border-left: 1px solid var(--mw-outline-variant); }
  .tray button:hover { background: color-mix(in srgb, var(--mw-on-surface-variant) 8%, transparent); }
  .tray button:focus-visible { outline: 2px solid var(--mw-primary); outline-offset: 1px; }
  .whole { color: var(--mw-primary); }
  .tray button.on { background: var(--mw-primary); color: var(--mw-on-primary); }
  .close { border-radius: 999px; padding: 2px 8px; color: var(--mw-on-surface-variant); }
  @media (prefers-reduced-motion: reduce) {
    .bar, .tray-wrap, .tray, .progress { transition: none; }
  }`;

function isBusy() {
  let sending = 0;
  for (const c of state.chunks.values()) sending += c.paras.filter((p) => p.translation == null).length;
  return state.pending.size + sending + state.looking > 0;
}

function mustStayOpen() {
  return isBusy() || !!bar.message || state.halted || bar.error;
}

function cancelAutoCollapse() {
  if (bar.collapseTimer) {
    clearTimeout(bar.collapseTimer);
    bar.collapseTimer = null;
  }
}

function setCollapsed(collapsed) {
  if (!bar.el) return;
  bar.collapsed = collapsed;
  bar.el.classList.toggle('collapsed', collapsed);
  bar.handle?.setAttribute('aria-expanded', String(!collapsed));
}

function scheduleCollapse(delayMs = AUTO_COLLAPSE_MS) {
  cancelAutoCollapse();
  if (mustStayOpen() || bar.hovering || bar.focusWithin || bar.dragging || bar.collapsed) return;
  bar.collapseTimer = setTimeout(() => {
    bar.collapseTimer = null;
    if (!mustStayOpen() && !bar.hovering && !bar.focusWithin && !bar.dragging) {
      setCollapsed(true);
    }
  }, delayMs);
}

function defaultTop() {
  const height = bar.el?.offsetHeight || 44;
  return window.innerHeight - height - DEFAULT_BOTTOM;
}

function clampTop(y) {
  const height = bar.el?.offsetHeight || 44;
  const maxY = Math.max(MARGIN_Y, window.innerHeight - height - MARGIN_Y);
  return Math.min(Math.max(MARGIN_Y, Math.round(y)), maxY);
}

function applyTop(y) {
  bar.topY = clampTop(y);
  if (bar.el) bar.el.style.top = `${bar.topY}px`;
}

function bindInteractions() {
  const el = bar.el;
  const handle = bar.handle;

  el.addEventListener('mouseenter', () => {
    bar.hovering = true;
    cancelAutoCollapse();
    if (!bar.pinnedClosed && bar.collapsed) setCollapsed(false);
  });
  el.addEventListener('mouseleave', () => {
    bar.hovering = false;
    bar.pinnedClosed = false;
    scheduleCollapse(LEAVE_COLLAPSE_MS);
  });
  el.addEventListener('focusin', () => {
    bar.focusWithin = true;
    cancelAutoCollapse();
    if (bar.collapsed) setCollapsed(false);
  });
  el.addEventListener('focusout', (e) => {
    if (!el.contains(e.relatedTarget)) {
      bar.focusWithin = false;
      scheduleCollapse(LEAVE_COLLAPSE_MS);
    }
  });

  // つまみの上下ドラッグとクリック開閉を両立する。
  let startY = 0;
  let startTop = 0;
  let moved = false;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    bar.dragging = true;
    moved = false;
    startY = e.clientY;
    startTop = bar.topY ?? el.getBoundingClientRect().top;
    el.classList.add('dragging');
    cancelAutoCollapse();
  });

  handle.addEventListener('pointermove', (e) => {
    if (!bar.dragging) return;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dy) >= 4) moved = true;
    if (moved) {
      bar.customTop = true;
      applyTop(startTop + dy);
    }
  });

  const finishDrag = (e) => {
    if (!bar.dragging) return;
    bar.dragging = false;
    el.classList.remove('dragging');
    if (handle.hasPointerCapture?.(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    if (!moved) {
      // クリック扱い：開いていれば畳み、閉じていれば開く。
      const nextCollapsed = !bar.collapsed;
      bar.pinnedClosed = nextCollapsed;
      setCollapsed(nextCollapsed);
      if (!nextCollapsed) cancelAutoCollapse();
    } else if (!bar.hovering) {
      scheduleCollapse(LEAVE_COLLAPSE_MS);
    }
  };
  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);

  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const nextCollapsed = !bar.collapsed;
      bar.pinnedClosed = nextCollapsed;
      setCollapsed(nextCollapsed);
    }
  });
}

let resizeListener = null;

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
      <div class="tray-wrap">
        <div class="tray">
          <span class="name">Mocking<span style="color:var(--mw-primary)">word</span></span>
          <span class="status"></span>
          <span class="group">
            <button type="button" data-mode="trans" title="訳文だけを表示">訳文</button>
            <button type="button" data-mode="orig" title="原文を表示">原文</button>
            <button type="button" data-mode="both" title="原文の下に訳文を表示">対訳</button>
          </span>
          <button type="button" class="whole" title="ページ全体を訳す">ページ全体を訳す</button>
          <button type="button" class="close" title="翻訳をやめて元のページに戻す">×</button>
        </div>
      </div>
      <button type="button" class="handle" aria-expanded="true" aria-label="Mockingword 翻訳バー（クリックで開閉・ドラッグで上下移動）" title="クリックで開閉・上下ドラッグで移動">
        <span class="icon-ring">
          <img src="${chrome.runtime.getURL('icons/icon32.png')}" alt="">
          <span class="dot"></span>
        </span>
      </button>
      <span class="progress idle"></span>
    </div>`;
  bar.el = root.querySelector('.bar');
  bar.handle = root.querySelector('.handle');
  bar.dot = root.querySelector('.dot');
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
  bar.collapsed = false;
  bar.hovering = false;
  bar.focusWithin = false;
  bar.dragging = false;
  bar.pinnedClosed = false;
  applyTop(bar.customTop && bar.topY != null ? bar.topY : defaultTop());
  bindInteractions();

  if (!resizeListener) {
    resizeListener = () => {
      if (!bar.host?.isConnected) return;
      applyTop(bar.customTop && bar.topY != null ? bar.topY : defaultTop());
    };
    window.addEventListener('resize', resizeListener, { passive: true });
  }

  // 待っている秒数を出し直す。バーを外したら止める。
  const tick = setInterval(() => (host.isConnected && alive() ? state.chunks.size && updateBar() : clearInterval(tick)), 1000);
}

export function showBar() {
  ensureBar();
  bar.pinnedClosed = false;
  setCollapsed(false);
  updateBar();
}

export function barShown() {
  return !!bar.host?.isConnected;
}

/** バーを外し、知らせと「訳し終えました」を消す（翻訳をやめたとき）。 */
export function removeBar() {
  cancelAutoCollapse();
  bar.done = '';
  bar.message = null;
  bar.error = false;
  bar.collapsed = false;
  bar.hovering = false;
  bar.focusWithin = false;
  bar.dragging = false;
  bar.pinnedClosed = false;
  bar.host?.remove();
  bar.el = null;
  bar.handle = null;
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
  bar.status.title = text;
  bar.status.classList.toggle('error', bar.error);
  for (const [mode, b] of Object.entries(bar.buttons)) b.classList.toggle('on', mode === state.mode);
  // つまみの状態ドットを更新する。
  bar.dot.classList.toggle('error', bar.error || state.halted);
  bar.dot.classList.toggle('orig', !bar.error && !state.halted && state.mode === 'orig');
  // 進み具合：訳し終えた段落 ÷（訳し終えた＋待っている＋送って返事を待っている段落）。
  let sending = 0;
  for (const c of state.chunks.values()) sending += c.paras.filter((p) => p.translation == null).length;
  const total = state.translated + state.pending.size + sending + state.looking;
  const busy = state.pending.size + sending + state.looking > 0;
  bar.progress.classList.toggle('idle', !busy);
  if (total) bar.progress.style.width = `${Math.round((state.translated / total) * 100)}%`;
  bar.whole.style.display = state.started ? 'none' : '';

  if (mustStayOpen()) {
    cancelAutoCollapse();
    if (!bar.pinnedClosed && bar.collapsed) setCollapsed(false);
  } else {
    scheduleCollapse(AUTO_COLLAPSE_MS);
  }
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
