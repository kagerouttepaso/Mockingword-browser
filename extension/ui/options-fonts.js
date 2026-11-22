// 設定画面の「ページの翻訳：訳文のフォント」UI。
// 4系統（サンセリフ・等幅・明朝・丸ゴシック）ごとに、おすすめ（★）優先＋Fontsource全日本語フォントの検索・選択と、
// 選択中フォントのプレビュー表示・キャッシュ管理を行う。

import { BUILTIN_FONTS, DEFAULT_PAGE_FONTS, FONT_CATEGORIES, JA_UNICODE_RANGE, normalizePageFonts } from '../shared/fonts.js';
import { MSG } from '../shared/messages.js';

const PREVIEW_LATIN = {
  sans: 'Inter, system-ui, sans-serif',
  mono: 'Consolas, Menlo, monospace',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: 'system-ui, sans-serif',
};

const CATEGORY_LABELS = {
  'sans-serif': 'サンセリフ',
  serif: '明朝・セリフ',
  monospace: '等幅',
  display: '装飾・見出し',
  handwriting: '手書き風',
};

const mb = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function initFontOptions() {
  const enabledBox = document.getElementById('pageFontsEnabled');
  const rowsRoot = document.getElementById('fontRows');
  const catalogNote = document.getElementById('fontCatalogNote');
  const resetBtn = document.getElementById('fontReset');
  const statsEl = document.getElementById('fontcachestats');
  const clearBtn = document.getElementById('fontcacheclear');
  if (!enabledBox || !rowsRoot) return;

  let current = normalizePageFonts((await chrome.storage.sync.get({ pageFonts: DEFAULT_PAGE_FONTS })).pageFonts);
  let catalog = [...BUILTIN_FONTS];
  const loadedPreview = new Set();
  const loadingPreview = new Set();

  const fontById = (id) => catalog.find((f) => f.id === id) ?? BUILTIN_FONTS.find((f) => f.id === id);

  function save() {
    return chrome.storage.sync.set({ pageFonts: current });
  }

  /** 設定画面のプレビュー用に、選ばれたフォントを Service Worker から読み込んで FontFace 登録する。 */
  async function ensurePreviewFont(fontId) {
    if (!fontId || loadedPreview.has(fontId) || loadingPreview.has(fontId)) return;
    loadingPreview.add(fontId);
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.FONT_LOAD, fontId });
      if (!res?.ok || !Array.isArray(res.faces)) return;
      const family = `MockingwordPreview-${fontId}`;
      for (const item of res.faces) {
        const face = new FontFace(family, base64ToBytes(item.data), {
          weight: item.weight,
          style: 'normal',
          unicodeRange: JA_UNICODE_RANGE,
        });
        await face.load();
        document.fonts.add(face);
      }
      loadedPreview.add(fontId);
      renderFontCache();
    } catch {
      // オフライン等で取得できなくても、設定自体は変えられるままにする。
    } finally {
      loadingPreview.delete(fontId);
    }
  }

  async function renderFontCache() {
    if (!statsEl) return;
    const s = await chrome.runtime.sendMessage({ type: MSG.FONT_CACHE_STATS }).catch(() => null);
    if (!s?.ok) return;
    statsEl.textContent = s.count
      ? `フォントのキャッシュ：${s.count} ファイル・約 ${mb(s.bytes)}`
      : 'フォントのキャッシュ：なし（翻訳で使った系統だけ初回に取得します）';
  }

  const rowRefs = new Map();

  function updateRowView(cat) {
    const ref = rowRefs.get(cat.id);
    if (!ref) return;
    const fontId = current[cat.id];
    const info = fontId ? fontById(fontId) : null;
    ref.nameEl.textContent = fontId ? (info?.family ?? fontId) : '指定しない（元のページのまま）';
    ref.previewEl.textContent = 'あいうえお 漢字の雰囲気を確認 OpenCode 123';
    ref.previewEl.style.fontFamily = fontId
      ? `"MockingwordPreview-${fontId}", ${PREVIEW_LATIN[cat.id]}`
      : PREVIEW_LATIN[cat.id];
    if (fontId && current.enabled) ensurePreviewFont(fontId);
  }

  function renderPickerList(cat, ref, query) {
    const q = query.trim().toLowerCase();
    const recSet = new Set(cat.recommended);
    const list = ref.listEl;
    list.replaceChildren();

    const makeOption = (id, label, meta, isRec) => {
      const wrap = document.createElement('div');
      wrap.className = 'font-option-row';

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'font-option' + (current[cat.id] === id ? ' selected' : '');
      const left = document.createElement('span');
      left.className = 'font-option-name';
      left.textContent = (isRec ? '★ ' : '') + label;
      const right = document.createElement('small');
      right.textContent = meta;
      if (id && loadedPreview.has(id)) {
        right.style.fontFamily = `"MockingwordPreview-${id}", ${PREVIEW_LATIN[cat.id]}`;
      }
      btn.append(left, right);
      btn.onclick = async () => {
        current = { ...current, [cat.id]: id };
        await save();
        updateRowView(cat);
        ref.pickerEl.hidden = true;
        ref.toggleBtn.textContent = '変更';
      };
      wrap.append(btn);

      if (id) {
        const tryBtn = document.createElement('button');
        tryBtn.type = 'button';
        tryBtn.className = 'font-try-btn';
        tryBtn.textContent = loadedPreview.has(id) ? '見本' : '試す';
        tryBtn.title = '設定を変えずにこのフォントを上の見本で試します';
        tryBtn.onclick = async (e) => {
          e.stopPropagation();
          tryBtn.disabled = true;
          tryBtn.textContent = '読込中…';
          await ensurePreviewFont(id);
          tryBtn.disabled = false;
          tryBtn.textContent = loadedPreview.has(id) ? '見本' : '試す';
          if (loadedPreview.has(id)) {
            right.style.fontFamily = `"MockingwordPreview-${id}", ${PREVIEW_LATIN[cat.id]}`;
            ref.previewEl.style.fontFamily = `"MockingwordPreview-${id}", ${PREVIEW_LATIN[cat.id]}`;
            ref.previewEl.textContent = `あいうえお 漢字の雰囲気を確認 OpenCode 123（試用中：${label}）`;
          }
        };
        wrap.append(tryBtn);
      }

      return wrap;
    };

    if (!q) {
      list.append(makeOption('', '指定しない（元のページのまま）', 'ブラウザー標準', false));
    }

    const matches = (f) => {
      if (!q) return true;
      const catJa = CATEGORY_LABELS[f.category] ?? '';
      return f.family.toLowerCase().includes(q) || f.id.includes(q) || f.category.toLowerCase().includes(q) || catJa.includes(q);
    };

    // おすすめを登録順で優先表示
    const recItems = cat.recommended
      .map((id) => fontById(id))
      .filter((f) => f && matches(f));
    if (recItems.length) {
      const h = document.createElement('div');
      h.className = 'font-group-title';
      h.textContent = '★ おすすめ';
      list.append(h);
      for (const f of recItems) {
        const meta = (f.id === cat.defaultId ? '既定・' : '') + (CATEGORY_LABELS[f.category] ?? f.category);
        list.append(makeOption(f.id, f.family, meta, true));
      }
    }

    // その他の日本語フォント（Fontsource 全件）
    const others = catalog.filter((f) => !recSet.has(f.id) && matches(f));
    if (others.length) {
      const h = document.createElement('div');
      h.className = 'font-group-title';
      h.textContent = `すべての日本語フォント（${others.length}件）`;
      list.append(h);
      for (const f of others) {
        list.append(makeOption(f.id, f.family, CATEGORY_LABELS[f.category] ?? f.category, false));
      }
    }

    if (!recItems.length && !others.length && q) {
      const empty = document.createElement('div');
      empty.className = 'font-empty';
      empty.textContent = '一致するフォントが見つかりませんでした';
      list.append(empty);
    }
  }

  function buildRows() {
    rowsRoot.replaceChildren();
    rowRefs.clear();
    for (const cat of FONT_CATEGORIES) {
      const row = document.createElement('div');
      row.className = 'font-row';

      const head = document.createElement('div');
      head.className = 'font-row-head';

      const titleBox = document.createElement('div');
      titleBox.className = 'font-row-title';
      const title = document.createElement('strong');
      title.textContent = cat.label;
      const hint = document.createElement('small');
      hint.textContent = cat.hint;
      titleBox.append(title, hint);

      const ctrl = document.createElement('div');
      ctrl.className = 'font-row-ctrl';
      const nameEl = document.createElement('span');
      nameEl.className = 'font-current-name';
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.textContent = '変更';
      ctrl.append(nameEl, toggleBtn);
      head.append(titleBox, ctrl);

      const previewEl = document.createElement('div');
      previewEl.className = 'font-preview';
      previewEl.textContent = 'あいうえお 漢字の雰囲気を確認 OpenCode 123';

      const pickerEl = document.createElement('div');
      pickerEl.className = 'font-picker';
      pickerEl.hidden = true;

      const searchEl = document.createElement('input');
      searchEl.type = 'search';
      searchEl.className = 'font-search';
      searchEl.placeholder = 'フォント名・種類で検索（例：Gothic, Mincho, Maru, Code）';
      const listEl = document.createElement('div');
      listEl.className = 'font-list';
      pickerEl.append(searchEl, listEl);

      row.append(head, previewEl, pickerEl);
      rowsRoot.append(row);

      const ref = { row, nameEl, previewEl, toggleBtn, pickerEl, searchEl, listEl };
      rowRefs.set(cat.id, ref);

      toggleBtn.onclick = () => {
        const opening = pickerEl.hidden;
        for (const [otherId, otherRef] of rowRefs) {
          if (otherId !== cat.id) {
            otherRef.pickerEl.hidden = true;
            otherRef.toggleBtn.textContent = '変更';
            updateRowView(FONT_CATEGORIES.find((c) => c.id === otherId));
          }
        }
        pickerEl.hidden = !opening;
        toggleBtn.textContent = opening ? '閉じる' : '変更';
        if (opening) {
          searchEl.value = '';
          renderPickerList(cat, ref, '');
          searchEl.focus();
        } else {
          updateRowView(cat);
        }
      };

      searchEl.oninput = () => renderPickerList(cat, ref, searchEl.value);
      updateRowView(cat);
    }
  }

  function applyEnabledState() {
    enabledBox.checked = current.enabled;
    rowsRoot.classList.toggle('is-disabled', !current.enabled);
    if (current.enabled) {
      for (const cat of FONT_CATEGORIES) {
        if (current[cat.id]) ensurePreviewFont(current[cat.id]);
      }
    }
  }

  buildRows();
  applyEnabledState();
  renderFontCache();

  enabledBox.onchange = async () => {
    current = { ...current, enabled: enabledBox.checked };
    await save();
    applyEnabledState();
  };

  resetBtn.onclick = async () => {
    current = { ...DEFAULT_PAGE_FONTS, enabled: current.enabled };
    await save();
    for (const cat of FONT_CATEGORIES) {
      const ref = rowRefs.get(cat.id);
      if (ref) {
        ref.pickerEl.hidden = true;
        ref.toggleBtn.textContent = '変更';
      }
      updateRowView(cat);
    }
  };

  clearBtn.onclick = async () => {
    clearBtn.disabled = true;
    await chrome.runtime.sendMessage({ type: MSG.FONT_CACHE_CLEAR });
    loadedPreview.clear();
    await renderFontCache();
    clearBtn.disabled = false;
  };

  // Fontsource の日本語全フォント一覧をバックグラウンドで取得し、検索対象を全件へ広げる。
  chrome.runtime.sendMessage({ type: MSG.FONT_CATALOG }).then((res) => {
    if (!res?.ok || !Array.isArray(res.fonts) || !res.fonts.length) return;
    catalog = res.fonts;
    for (const cat of FONT_CATEGORIES) {
      updateRowView(cat);
      const ref = rowRefs.get(cat.id);
      if (ref && !ref.pickerEl.hidden) renderPickerList(cat, ref, ref.searchEl.value);
    }
    if (catalogNote) {
      catalogNote.textContent = res.offline
        ? `オフラインのためおすすめ一覧（${catalog.length}件）を表示しています。`
        : `Fontsource の日本語対応フォント ${catalog.length} 件から検索して選べます。`;
    }
  }).catch(() => {});

  // 別タブで設定が変わったときに同期する。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.pageFonts) return;
    current = normalizePageFonts(changes.pageFonts.newValue);
    applyEnabledState();
    for (const cat of FONT_CATEGORIES) updateRowView(cat);
  });
}
