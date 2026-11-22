// ページ翻訳の日本語フォントのカタログ取得と WOFF2 ダウンロード・キャッシュ（Service Worker 側）。
// 閲覧中ページから外部サーバーへ通信せず、Service Worker 経由で初回だけ取得して Cache Storage に保存する。

import { BUILTIN_FONTS, CUSTOM_FONTS, fontFileSpec, pickFontWeights } from '../shared/fonts.js';

const CATALOG_URL = 'https://api.fontsource.org/v1/fonts?subsets=japanese';
const CATALOG_CACHE_KEY = 'fontCatalogCache';
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FONT_CACHE_NAME = 'mockingword-page-fonts';

/** カタログへ特別登録フォント（CUSTOM_FONTS）を重複なしで合流させる。 */
function mergeCustomFonts(fonts) {
  const map = new Map();
  for (const f of CUSTOM_FONTS) map.set(f.id, trimEntry(f));
  for (const f of fonts) if (!map.has(f.id)) map.set(f.id, f);
  return [...map.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** ArrayBuffer をチャンク単位で Base64 文字列へ変換する（大きいファイルでもスタック溢れしない）。 */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const parts = [];
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + step)));
  }
  return btoa(parts.join(''));
}

/** カタログの1件を最小限の形へそろえる。 */
function trimEntry(f) {
  return {
    id: String(f.id),
    family: String(f.family),
    category: String(f.category || 'sans-serif'),
    weights: Array.isArray(f.weights) && f.weights.length ? f.weights.map(Number) : [400],
  };
}

let catalogInFlight = null;

/**
 * Fontsource の日本語対応フォント一覧を返す。
 * ローカルに有効期限内のキャッシュがあればそれを使い、無ければ API から取得して保存する。
 * オフライン等で失敗した場合は同梱の BUILTIN_FONTS を返す。
 */
export async function getFontCatalog(forceRefresh = false) {
  if (!forceRefresh) {
    try {
      const saved = (await chrome.storage.local.get(CATALOG_CACHE_KEY))[CATALOG_CACHE_KEY];
      if (saved?.fonts?.length && Date.now() - saved.at < CATALOG_TTL_MS) {
        return { ok: true, fonts: mergeCustomFonts(saved.fonts), cached: true, offline: false };
      }
    } catch {}
  }

  if (catalogInFlight) return catalogInFlight;
  catalogInFlight = (async () => {
    try {
      const res = await fetch(CATALOG_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const fonts = Array.isArray(raw)
        ? raw.filter((f) => f?.id && f?.family).map(trimEntry).sort((a, b) => a.family.localeCompare(b.family))
        : [];
      if (!fonts.length) throw new Error('フォント一覧が空です');
      await chrome.storage.local.set({ [CATALOG_CACHE_KEY]: { at: Date.now(), fonts } }).catch(() => {});
      return { ok: true, fonts: mergeCustomFonts(fonts), cached: false, offline: false };
    } catch (e) {
      // 期限切れキャッシュがあればそれを優先し、無ければ同梱のおすすめ一覧を返す。
      try {
        const saved = (await chrome.storage.local.get(CATALOG_CACHE_KEY))[CATALOG_CACHE_KEY];
        if (saved?.fonts?.length) return { ok: true, fonts: mergeCustomFonts(saved.fonts), cached: true, offline: true, error: e.message };
      } catch {}
      return { ok: true, fonts: mergeCustomFonts(BUILTIN_FONTS), cached: false, offline: true, error: e.message };
    } finally {
      catalogInFlight = null;
    }
  })();
  return catalogInFlight;
}

/** 1つのフォントファイル（WOFF2 / TTF）を Cache Storage から読むか、配布元から取得して保存する。 */
async function fetchFontFile(url, contentType) {
  const cache = await caches.open(FONT_CACHE_NAME);
  const hit = await cache.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if (buf.byteLength > 0) return buf;
    await cache.delete(url);
  }
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`フォントを取得できませんでした（${res.status}）`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new Error('フォントデータが空です');
  await cache.put(url, new Response(buf, { headers: { 'content-type': contentType } }));
  return buf;
}

const fontInFlight = new Map();

/**
 * 指定されたフォント ID の日本語フォント（標準・太字）を取得し、
 * コンテンツスクリプトや設定画面で FontFace へ渡せる Base64 配列で返す。
 */
export async function loadPageFont(fontId) {
  if (!fontId || typeof fontId !== 'string' || !/^[a-z0-9-]+$/.test(fontId)) {
    return { ok: false, error: 'フォントIDが不正です' };
  }
  if (fontInFlight.has(fontId)) return fontInFlight.get(fontId);

  const task = (async () => {
    // カタログまたは同梱一覧から利用可能ウェイトを引く。
    const builtin = BUILTIN_FONTS.find((f) => f.id === fontId);
    let weights = builtin?.weights;
    if (!weights) {
      const cat = await getFontCatalog();
      weights = cat.fonts.find((f) => f.id === fontId)?.weights;
    }
    const targetWeights = pickFontWeights(weights ?? [400]);

    const faces = [];
    for (const w of targetWeights) {
      const spec = fontFileSpec(fontId, w);
      if (!spec) continue;
      try {
        const buf = await fetchFontFile(spec.url, spec.contentType);
        faces.push({ weight: String(w), data: bufferToBase64(buf) });
      } catch (e) {
        if (faces.length === 0 && w === targetWeights[targetWeights.length - 1]) {
          throw e;
        }
      }
    }
    if (!faces.length) throw new Error('フォントを読み込めませんでした');
    return { ok: true, id: fontId, faces };
  })().finally(() => {
    fontInFlight.delete(fontId);
  });

  fontInFlight.set(fontId, task);
  return task;
}

/** ページ翻訳用フォントの Cache Storage の件数と合計バイト数を返す。 */
export async function fontCacheStats() {
  const cache = await caches.open(FONT_CACHE_NAME);
  const keys = await cache.keys();
  let bytes = 0;
  for (const req of keys) {
    const res = await cache.match(req);
    if (!res) continue;
    const len = Number(res.headers.get('content-length'));
    if (Number.isFinite(len) && len > 0) bytes += len;
    else bytes += (await res.arrayBuffer()).byteLength;
  }
  return { count: keys.length, bytes };
}

/** ページ翻訳用フォントの Cache Storage とカタログキャッシュを削除する。 */
export async function clearFontCache() {
  await caches.delete(FONT_CACHE_NAME);
  await chrome.storage.local.remove(CATALOG_CACHE_KEY).catch(() => {});
}
