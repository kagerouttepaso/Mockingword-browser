// 設定のテーマをページ上の拡張パネルにも適用する。Webページ自体の明暗は変えない。
globalThis.__mockingwordTheme = 'system';
function applyMockingwordTheme(value) {
  globalThis.__mockingwordTheme = ['light','dark'].includes(value) ? value : 'system';
  document.querySelectorAll('.plamo-ui,.plamo-ui-host').forEach(el => {
    el.dataset.mwTheme = globalThis.__mockingwordTheme;
  });
}
chrome.storage.sync.get({theme:'system'}).then(s=>applyMockingwordTheme(s.theme)).catch(()=>{});
chrome.storage.onChanged.addListener((c,area)=>{if(area==='sync'&&c.theme)applyMockingwordTheme(c.theme.newValue)});
// すべてのページに入れる小さな部品。次の2つだけを行い、ページの文字を外へ送ることはない。
// 1. ページを読み込んだことをService Workerへ知らせる（同じサイト内で移ったページも続けて訳すため。ホスト名と文書の種類だけ。
//    種類は、PDF のように内蔵ビューアで表示する文書で右クリックのメニューを絞るため）。
// 2. 文章を選んだら、選択範囲の近くに「訳」アイコンを出す（押すと選択範囲の訳を吹き出しで出す）。
// manifest の content_scripts で入れる通常のスクリプトなので import できない。メッセージの名前（'page-loaded'・'selection-icon'）と
// 選択の判定は shared/messages.js・shared/text.js の worthSelection と同じものを直接書いている。
/** 拡張機能へ知らせる。拡張機能を再読み込みした後の古いタブでは接続が切れており、その場で例外になるので黙って止める。 */
function tell(message) {
  if (!chrome.runtime?.id) return;
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    // 接続が切れた直後
  }
}

if (window.top === window) {
  const notify = () => tell({ type: 'page-loaded', host: location.hostname, contentType: document.contentType });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notify, { once: true });
  else notify();
}

// ---------------- 選択範囲の「訳」アイコン ----------------
// Google 翻訳の拡張機能のように、文章を選び終えたら選択範囲の右下に小さなアイコンを浮かび上がらせる。
// 押したときだけ選択した文をService Workerへ送る（選んだだけでは送らない）。設定の「選択したときにアイコンを出す」で切り替える。
(() => {
  let enabled = true;
  try {
    chrome.storage.sync.get({ selectionIcon: true }).then((s) => (enabled = !!s.selectionIcon)).catch(() => {});
    chrome.storage.onChanged.addListener((c, area) => {
      if (area === 'sync' && c.selectionIcon) enabled = !!c.selectionIcon.newValue;
    });
  } catch {
    // 接続が切れた後に読み込まれた場合
  }

  let host = null;
  let button = null;
  let text = '';

  function create() {
    host = document.createElement('div');
    host.className = 'plamo-ui-host';
    host.dataset.mwTheme = globalThis.__mockingwordTheme;
    host.setAttribute('translate', 'no');
    host.style.cssText = 'all: initial !important; position: fixed !important; z-index: 2147483647 !important;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
${globalThis.__mockingwordThemeCss}
        button {
          all: unset; box-sizing: border-box; width: 32px; height: 32px; border-radius: 10px;
          display: grid; place-items: center; cursor: pointer;
          font: bold 14px/1 "Yu Gothic UI", "Meiryo UI", system-ui, sans-serif; color: #fff;
          background: var(--mw-surface-container-low); border: 2px solid var(--mw-primary); box-shadow: 0 3px 10px rgba(0, 0, 0, 0.25);
          opacity: 0; transform: translateY(4px) scale(0.6);
          transition: opacity 0.16s ease-out, transform 0.18s cubic-bezier(0.2, 0.9, 0.3, 1.3);
        }
        button.show { opacity: 1; transform: none; }
        button:hover { border-color: var(--mw-primary); }
        img { width: 30px; height: 30px; display:block; }
      </style>
      <button title="選択範囲を日本語に訳す（Mockingword）" aria-label="選択範囲を日本語に訳す"><img src="${chrome.runtime.getURL('icons/icon32.png')}" alt=""></button>`;
    button = root.querySelector('button');
    // 押しても選択が外れないよう、mousedown の既定の動きを止める。
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = text;
      hide();
      tell({ type: 'selection-icon', text: t });
    });
  }

  function hide() {
    host?.remove();
    button?.classList.remove('show');
  }

  /** 訳す価値のある選択か（shared/text.js の worthSelection と同じ）。日本語（かな）を含むもの・文字の無いもの・長すぎるものは出さない。 */
  function worth(s) {
    return s.length >= 2 && s.length <= 5000 && /\p{L}/u.test(s) && !/[぀-ヿ]/.test(s);
  }

  /** 入力欄・編集できる場所・拡張機能自身の吹き出しやバーの中の選択には出さない。 */
  function insideIgnored(node) {
    const el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!el) return true;
    if (el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .plamo-ui, .plamo-ui-host')) return true;
    return el.isContentEditable;
  }

  function showSoon() {
    // 選択が確定してから見る（mouseup の直後はまだ選択が変わることがある）。
    setTimeout(() => {
      if (!enabled || !chrome.runtime?.id) return hide();
      const sel = window.getSelection();
      const s = sel?.toString().trim() ?? '';
      if (!sel || sel.isCollapsed || !worth(s) || insideIgnored(sel.anchorNode) || insideIgnored(sel.focusNode)) return hide();
      const rects = sel.getRangeAt(0).getClientRects();
      const last = rects[rects.length - 1];
      if (!last) return hide();
      text = s;
      if (!host) create();
      // 選択範囲の最後の行の右下。画面からはみ出さないようにする。
      const x = Math.min(Math.max(4, last.right + 4), window.innerWidth - 34);
      const y = Math.min(Math.max(4, last.bottom + 4), window.innerHeight - 34);
      host.style.setProperty('left', x + 'px', 'important');
      host.style.setProperty('top', y + 'px', 'important');
      button.classList.remove('show');
      host.dataset.mwTheme = globalThis.__mockingwordTheme;
      document.documentElement.appendChild(host);
      requestAnimationFrame(() => requestAnimationFrame(() => button.classList.add('show')));
    }, 10);
  }

  document.addEventListener('mouseup', (e) => {
    if (e.button === 0 && !(host && e.composedPath().includes(host))) showSoon();
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Shift') showSoon();
    if (e.key === 'Escape') hide();
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (host && !e.composedPath().includes(host)) hide();
  }, true);
  document.addEventListener('selectionchange', () => {
    if (host?.isConnected && window.getSelection()?.isCollapsed) hide();
  });
  window.addEventListener('scroll', hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
})();
