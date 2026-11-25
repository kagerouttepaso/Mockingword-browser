// PDF の訳文に使うフォント（Noto Sans の標準・太字）。訳文の言語ごとに、その文字を持つフォントを使う（shared/languages.js の pdf）。
// 拡張機能の ZIP には入れず、初めて使うときに固定URLから取得し、大きさと SHA-256 を確かめてから Cache Storage に保存する
// （docs/12_PDFの翻訳.md「フォント」）。字幅は FontFace と OffscreenCanvas の measureText で測る（PDF へ書く字形と同じフォントの送り幅）。

const CDN = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts';
const font = (pkg, name, size, sha256) => ({ url: `${CDN}/${pkg}/${name}`, size, sha256 });

/**
 * 訳文の言語の種類 → 標準・太字のフォント。版は固定し、大きさと SHA-256 で取得したものを確かめる。
 * latin（Noto Sans）はラテン文字・キリル文字・ギリシャ文字とベトナム語の文字を持つ（CJK のフォントは東欧の言語の文字の一部を持たない。
 * 2026-11-25、各フォントの cmap で、訳文の言語に選べる言語の文字を確かめた）。
 */
export const FONT_SETS = {
  jp: {
    regular: font('noto-sans-jp@0.4.4', '400Regular/NotoSansJP_400Regular.ttf', 5731428, '6255ea4692e97ef27330304fb96fd650f9111f868cd585fcf2802d42823930e5'),
    bold: font('noto-sans-jp@0.4.4', '700Bold/NotoSansJP_700Bold.ttf', 5726432, '7c03e14d8a03e8f5181dbd130712d51e4ae01ac648cbd59442ae8b16c0951835'),
  },
  sc: {
    regular: font('noto-sans-sc@0.4.4', '400Regular/NotoSansSC_400Regular.ttf', 10559284, 'd45f67f0a7c0ca3f256950777ce6a61cc7ce5f9696d02900cbbaac25f8aa7d16'),
    bold: font('noto-sans-sc@0.4.4', '700Bold/NotoSansSC_700Bold.ttf', 10549020, '9a38ae0ab28cd5a256f9ea8e00dedc688aac17f7915fcb000572990afa956b96'),
  },
  tc: {
    regular: font('noto-sans-tc@0.4.4', '400Regular/NotoSansTC_400Regular.ttf', 7109460, 'add35d53f70727657b4509531677c4e3712b67df3d54661efdee5d3a0c16d954'),
    bold: font('noto-sans-tc@0.4.4', '700Bold/NotoSansTC_700Bold.ttf', 7104212, 'ed4ae6ed781e34d0beee896e9be5d835a938ac7adabbcc1b6b6904290006f372'),
  },
  kr: {
    regular: font('noto-sans-kr@0.4.4', '400Regular/NotoSansKR_400Regular.ttf', 6191364, 'b4a747e78805bc25b610dcfc3003cb5fb2e2ec034763774b24216ed15889eef4'),
    bold: font('noto-sans-kr@0.4.4', '700Bold/NotoSansKR_700Bold.ttf', 6189424, 'c76f806dc46b8e7981410cb083801f7f124b7f8bc0d181cdae80e78f16d0e9cc'),
  },
  latin: {
    regular: font('noto-sans@0.4.2', '400Regular/NotoSans_400Regular.ttf', 629024, 'fe8c022f48d8dd29f17b744d16f9346f4357e16f7d4f7be58b000ae7c291b614'),
    bold: font('noto-sans@0.4.2', '700Bold/NotoSans_700Bold.ttf', 630968, '13a813c49624ae3ba3c5c6e72c5ebffc4b9e1e6ea32f421c04069b037c6ad431'),
  },
};
const CACHE = 'mockingword-pdf-fonts';
/** 字幅を測り、画面に重ねる訳文を描くフォント名。種類ごとに分ける（同じ画面で訳文の言語を変えても混ざらない）。 */
const familyOf = (kind) => `MockingwordPdf-${kind}`;

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
async function measurer(family, weight, bytes) {
  const face = new FontFace(family, bytes, { weight });
  await face.load();
  (globalThis.document?.fonts ?? globalThis.fonts).add(face);
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  ctx.font = `${weight} 100px "${family}"`;
  const memo = new Map();
  return {
    measure: (text, size) => {
      let w = memo.get(text);
      if (w === undefined) memo.set(text, (w = ctx.measureText(text).width / 100));
      return w * size;
    },
  };
}

/**
 * 訳文の言語の種類 kind（shared/languages.js の pdfFontOf）の標準・太字のフォントを用意する。
 * 返す値：{ family, regular: { bytes, measure }, bold: { … } }。
 */
export async function loadFonts(kind, onProgress) {
  const set = FONT_SETS[kind];
  if (!set) throw new Error('この言語の訳文はPDFに書けません');
  const family = familyOf(kind);
  const total = set.regular.size + set.bold.size;
  const done = { regular: 0, bold: 0 };
  const report = (key) => (n) => { done[key] = n; onProgress?.(done.regular + done.bold, total); };
  const [regular, bold] = await Promise.all([fontBytes(set.regular, report('regular')), fontBytes(set.bold, report('bold'))]);
  const [regularMetrics, boldMetrics] = await Promise.all([measurer(family, '400', regular), measurer(family, '700', bold)]);
  return { family, regular: { bytes: regular, ...regularMetrics }, bold: { bytes: bold, ...boldMetrics } };
}

export const measureWithFonts = (fonts) => (text, bold, size) => fonts[bold ? 'bold' : 'regular'].measure(text, size);
