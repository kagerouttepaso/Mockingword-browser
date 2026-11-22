// ページ側の日本語フォント適用。元の要素の font-family から4系統（サンセリフ・等幅・明朝・丸ゴシック）を判定し、
// Service Worker がキャッシュした WOFF2 を FontFace（日本語 unicode-range 限定）として登録して訳文へ当てる。

import { DEFAULT_PAGE_FONTS, JA_UNICODE_RANGE, classifyFontFamily, normalizePageFonts, pageFontName } from '../shared/fonts.js';
import { MSG } from '../shared/messages.js';

let config = { ...DEFAULT_PAGE_FONTS };
let configLoaded = false;
let listening = false;

/** 計算済み font-family 文字列 → 系統（'sans'|'mono'|'serif'|'rounded'|null）のキャッシュ。 */
const categoryCache = new Map();
/** このページに登録済みの FontFace（系統 → { fontId, faces: FontFace[] }）。 */
const installed = new Map();
/** 読み込み中の系統 → fontId。重複要求を防ぐ。 */
const loading = new Map();

let measureCtx = null;

/** Canvas の実測で、先頭フォントが等幅かどうかを判定する（名前に mono が無い独自フォント対策）。 */
function isMonospaceByMeasure(fontFamily) {
  if (typeof document === 'undefined') return false;
  try {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return false;
    measureCtx.font = `24px ${fontFamily}`;
    const wI = measureCtx.measureText('iiiiii').width;
    const wW = measureCtx.measureText('WWWWWW').width;
    const wM = measureCtx.measureText('MMMMMM').width;
    if (wW <= 0) return false;
    return Math.abs(wI - wW) / wW < 0.05 && Math.abs(wM - wW) / wW < 0.05;
  } catch {
    return false;
  }
}

/** font-family 文字列から系統を判定する（キャッシュ付き）。 */
function detectCategory(fontFamily) {
  if (!fontFamily) return 'sans';
  if (categoryCache.has(fontFamily)) return categoryCache.get(fontFamily);
  const { category, ambiguous } = classifyFontFamily(fontFamily);
  const resolved = category === 'sans' && ambiguous && isMonospaceByMeasure(fontFamily) ? 'mono' : category;
  categoryCache.set(fontFamily, resolved);
  return resolved;
}

/** Base64 文字列を Uint8Array へ戻す（fetch を使わず CSP の影響を受けない）。 */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 指定した系統の FontFace をページへ登録する。読み込みは非同期で行い、翻訳表示を待たせない。 */
function ensureCategoryFont(category, fontId) {
  if (!fontId || typeof FontFace === 'undefined' || !document?.fonts) return;
  if (installed.get(category)?.fontId === fontId) return;
  if (loading.get(category) === fontId) return;
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

  loading.set(category, fontId);
  chrome.runtime.sendMessage({ type: MSG.FONT_LOAD, fontId }).then(async (res) => {
    if (loading.get(category) !== fontId) return;
    loading.delete(category);
    if (!res?.ok || !Array.isArray(res.faces)) return;

    // 同じ系統の古い FontFace があれば外す。
    const prev = installed.get(category);
    if (prev) {
      for (const f of prev.faces) document.fonts.delete(f);
      installed.delete(category);
    }

    const family = pageFontName(category);
    const added = [];
    for (const item of res.faces) {
      try {
        const bytes = base64ToBytes(item.data);
        const face = new FontFace(family, bytes, {
          weight: item.weight,
          style: 'normal',
          unicodeRange: JA_UNICODE_RANGE,
        });
        await face.load();
        // ロード中に設定が変わっていたら捨てる。
        if (!config.enabled || config[category] !== fontId) return;
        document.fonts.add(face);
        added.push(face);
      } catch {}
    }
    if (added.length) installed.set(category, { fontId, faces: added });
  }).catch(() => {
    if (loading.get(category) === fontId) loading.delete(category);
  });
}

/** 設定画面での変更を、翻訳中のページへ即座に反映する。 */
function refreshAppliedSpans() {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  for (const span of document.querySelectorAll('.plamo-tr')) {
    const orig = span.dataset?.plamoOrigFont;
    if (!orig) continue;
    applyToSpan(span, orig);
  }
}

function applyToSpan(span, origFontFamily) {
  const category = detectCategory(origFontFamily);
  const fontId = config.enabled && category ? config[category] : '';
  if (!fontId) {
    span.removeAttribute?.('data-plamo-font');
    if (span.style) span.style.fontFamily = '';
    return;
  }
  span.setAttribute?.('data-plamo-font', category);
  if (span.style) span.style.fontFamily = `"${pageFontName(category)}", ${origFontFamily}`;
  ensureCategoryFont(category, fontId);
}

function sameConfig(a, b) {
  return a.enabled === b.enabled && a.sans === b.sans && a.mono === b.mono && a.serif === b.serif && a.rounded === b.rounded;
}

/** フォント設定を読み込み、変更の監視を始める。 */
export function initPageFonts() {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) return;
  if (!configLoaded) {
    configLoaded = true;
    chrome.storage.sync.get({ pageFonts: DEFAULT_PAGE_FONTS }).then(({ pageFonts }) => {
      const next = normalizePageFonts(pageFonts);
      if (sameConfig(config, next)) return;
      config = next;
      refreshAppliedSpans();
    }).catch(() => {});
  }
  if (!listening && chrome.storage.onChanged) {
    listening = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !changes.pageFonts) return;
      const next = normalizePageFonts(changes.pageFonts.newValue);
      if (sameConfig(config, next)) return;
      config = next;
      refreshAppliedSpans();
    });
  }
}

/** 訳文の要素へ、元の段落の雰囲気に合う日本語フォントを当てる。読み取り段で取得済みの para.fontFamily を使い、書き込み段で getComputedStyle を呼ばない。 */
export function applyTranslationFont(para, span) {
  if (!span?.style) return;
  initPageFonts();
  let origFontFamily = para.fontFamily;
  if (!origFontFamily && typeof getComputedStyle === 'function') {
    const target = para.root?.isConnected ? para.root : para.element;
    if (target) {
      try {
        origFontFamily = getComputedStyle(target).fontFamily;
      } catch {}
    }
  }
  if (!origFontFamily) return;
  if (span.dataset) span.dataset.plamoOrigFont = origFontFamily;
  applyToSpan(span, origFontFamily);
}

/** 登録した FontFace を外す（翻訳をやめて元のページに戻すとき）。 */
export function clearPageFonts() {
  loading.clear();
  if (typeof document !== 'undefined' && document.fonts) {
    for (const { faces } of installed.values()) {
      for (const f of faces) document.fonts.delete(f);
    }
  }
  installed.clear();
}
