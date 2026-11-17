// 訳文に使う日本語フォント（Noto Sans JP の標準・太字）。拡張機能の ZIP には入れず、初めて使うときに固定URLから取得し、
// 大きさと SHA-256 を確かめてから Cache Storage に保存する（docs/12_PDFの翻訳.md「フォント」）。
// 字幅は FontFace と OffscreenCanvas の measureText で測る（PDF へ書く字形と同じフォントの送り幅）。

const BASE = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts/noto-sans-jp@0.4.4';
export const FONTS = {
  regular: { url: `${BASE}/400Regular/NotoSansJP_400Regular.ttf`, size: 5731428, sha256: '6255ea4692e97ef27330304fb96fd650f9111f868cd585fcf2802d42823930e5' },
  bold: { url: `${BASE}/700Bold/NotoSansJP_700Bold.ttf`, size: 5726432, sha256: '7c03e14d8a03e8f5181dbd130712d51e4ae01ac648cbd59442ae8b16c0951835' },
};
const CACHE = 'mockingword-pdf-fonts';

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** フォントのバイト列を返す。キャッシュに無ければ取得して確かめる。onProgress(読んだバイト数, 全体) で取得の進み具合を知らせる。 */
async function fontBytes(entry, onProgress) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(entry.url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    if (buf.byteLength === entry.size) return buf;
    await cache.delete(entry.url);
  }
  const response = await fetch(entry.url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`フォントを取得できませんでした（${response.status}）`);
  const reader = response.body.getReader();
  const parts = [];
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    read += value.length;
    onProgress?.(read, entry.size);
  }
  const buf = await new Blob(parts).arrayBuffer();
  if (buf.byteLength !== entry.size || hex(await crypto.subtle.digest('SHA-256', buf)) !== entry.sha256) {
    throw new Error('取得したフォントが固定した版と一致しません');
  }
  await cache.put(entry.url, new Response(buf, { headers: { 'content-type': 'font/ttf' } }));
  return buf;
}

/** フォントを登録し、字幅を測る関数を返す。measure は (文字列, 大きさ pt) → 幅 pt。 */
async function measurer(name, bytes) {
  const face = new FontFace(name, bytes);
  await face.load();
  (globalThis.document?.fonts ?? globalThis.fonts).add(face);
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  ctx.font = `100px "${name}"`;
  const memo = new Map();
  return {
    measure: (text, size) => {
      let w = memo.get(text);
      if (w === undefined) memo.set(text, (w = ctx.measureText(text).width / 100));
      return w * size;
    },
  };
}

/** 標準・太字のフォントを用意する。返す値：{ regular: { bytes, measure }, bold: { … } }。 */
export async function loadFonts(onProgress) {
  const total = FONTS.regular.size + FONTS.bold.size;
  const done = { regular: 0, bold: 0 };
  const report = (key) => (n) => { done[key] = n; onProgress?.(done.regular + done.bold, total); };
  const [regular, bold] = await Promise.all([fontBytes(FONTS.regular, report('regular')), fontBytes(FONTS.bold, report('bold'))]);
  return {
    regular: { bytes: regular, ...(await measurer('MockingwordPdfRegular', regular)) },
    bold: { bytes: bold, ...(await measurer('MockingwordPdfBold', bold)) },
  };
}
