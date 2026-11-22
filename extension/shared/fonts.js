// ページ翻訳の日本語フォント（4系統の分類・おすすめ一覧・既定値・unicode-range）。
// 純粋な規則だけを置き、DOM・chrome には触れない（tools/architecture.test.mjs の PURE 対象）。

/** 元のページのフォントを分類する4系統と、各系統の既定・おすすめ（Fontsource の id）。 */
export const FONT_CATEGORIES = [
  {
    id: 'sans',
    label: 'サンセリフ（本文・一般）',
    hint: 'Inter・Roboto・Helvetica などの一般的な本文やUI',
    defaultId: 'noto-sans-jp',
    recommended: ['noto-sans-jp', 'ibm-plex-sans-jp', 'biz-udpgothic', 'line-seed-jp', 'zen-kaku-gothic-new', 'm-plus-1p'],
  },
  {
    id: 'mono',
    label: '等幅（ターミナル・コード風）',
    hint: 'OpenTUI Mono・JetBrains Mono・Consolas などの等幅フォント',
    defaultId: 'm-plus-1-code',
    recommended: ['m-plus-1-code', 'biz-udgothic', 'dotgothic16', 'ibm-plex-sans-jp'],
  },
  {
    id: 'serif',
    label: '明朝（記事・セリフ）',
    hint: 'Georgia・Merriweather・Times などのセリフ体',
    defaultId: 'noto-serif-jp',
    recommended: ['noto-serif-jp', 'shippori-mincho', 'biz-udpmincho', 'zen-old-mincho', 'sawarabi-mincho'],
  },
  {
    id: 'rounded',
    label: '丸ゴシック（柔らかい書体）',
    hint: 'Nunito・Quicksand などの丸みのあるフォント',
    defaultId: 'm-plus-rounded-1c',
    recommended: ['m-plus-rounded-1c', 'line-seed-jp', 'zen-maru-gothic', 'kosugi-maru', 'tsukimi-rounded'],
  },
];

export const DEFAULT_PAGE_FONTS = {
  enabled: true,
  sans: 'noto-sans-jp',
  mono: 'm-plus-1-code',
  serif: 'noto-serif-jp',
  rounded: 'm-plus-rounded-1c',
};

/** オフライン時やカタログ未取得時にも使える、おすすめフォントの基本情報。 */
export const BUILTIN_FONTS = [
  { id: 'noto-sans-jp', family: 'Noto Sans JP', category: 'sans-serif', weights: [400, 700] },
  { id: 'ibm-plex-sans-jp', family: 'IBM Plex Sans JP', category: 'sans-serif', weights: [400, 700] },
  { id: 'biz-udpgothic', family: 'BIZ UDPGothic', category: 'sans-serif', weights: [400, 700] },
  { id: 'line-seed-jp', family: 'LINE Seed JP', category: 'sans-serif', weights: [400, 700] },
  { id: 'zen-kaku-gothic-new', family: 'Zen Kaku Gothic New', category: 'sans-serif', weights: [400, 700] },
  { id: 'm-plus-1p', family: 'M PLUS 1p', category: 'sans-serif', weights: [400, 700] },
  { id: 'm-plus-1-code', family: 'M PLUS 1 Code', category: 'monospace', weights: [400, 700] },
  { id: 'biz-udgothic', family: 'BIZ UDGothic', category: 'sans-serif', weights: [400, 700] },
  { id: 'dotgothic16', family: 'DotGothic16', category: 'sans-serif', weights: [400] },
  { id: 'noto-serif-jp', family: 'Noto Serif JP', category: 'serif', weights: [400, 700] },
  { id: 'shippori-mincho', family: 'Shippori Mincho', category: 'serif', weights: [400, 700] },
  { id: 'biz-udpmincho', family: 'BIZ UDPMincho', category: 'serif', weights: [400, 700] },
  { id: 'zen-old-mincho', family: 'Zen Old Mincho', category: 'serif', weights: [400, 700] },
  { id: 'sawarabi-mincho', family: 'Sawarabi Mincho', category: 'serif', weights: [400] },
  { id: 'm-plus-rounded-1c', family: 'M PLUS Rounded 1c', category: 'sans-serif', weights: [400, 700] },
  { id: 'zen-maru-gothic', family: 'Zen Maru Gothic', category: 'sans-serif', weights: [400, 700] },
  { id: 'kosugi-maru', family: 'Kosugi Maru', category: 'sans-serif', weights: [400] },
  { id: 'tsukimi-rounded', family: 'Tsukimi Rounded', category: 'sans-serif', weights: [400, 700] },
];

/**
 * 日本語文字に限定する unicode-range。
 * 訳文中の英数字・記号は元サイトの欧文フォント（OpenTUI Mono・Inter 等）をそのまま活かし、
 * 日本語の文字（句読点・かな・カナ・漢字・全角記号）だけに選択フォントを当てる。
 */
export const JA_UNICODE_RANGE = [
  'U+3000-303F',
  'U+3040-309F',
  'U+30A0-30FF',
  'U+31F0-31FF',
  'U+3400-4DBF',
  'U+4E00-9FFF',
  'U+F900-FAFF',
  'U+FF00-FFEF',
  'U+20000-2A6DF',
].join(', ');

/** ページ内の FontFace に登録する内部ファミリー名。 */
export const pageFontName = (category) => `MockingwordFont-${category}`;

const FONT_ID_RE = /^[a-z0-9-]+$/;

/** 保存済みのフォント設定を安全な形にそろえる。空文字は「指定しない（元のページのまま）」。 */
export function normalizePageFonts(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { enabled: src.enabled !== undefined ? Boolean(src.enabled) : DEFAULT_PAGE_FONTS.enabled };
  for (const cat of FONT_CATEGORIES) {
    const v = src[cat.id];
    out[cat.id] = v === '' ? '' : typeof v === 'string' && FONT_ID_RE.test(v) ? v : cat.defaultId;
  }
  return out;
}

/** 利用可能なウェイト一覧から、標準（400系）と太字（700系）の最大2つを選ぶ。 */
export function pickFontWeights(weights) {
  const list = [...new Set((weights ?? []).map(Number).filter((n) => n >= 100 && n <= 900))].sort((a, b) => a - b);
  if (list.length === 0) return [400];
  const regular = list.includes(400) ? 400 : list.reduce((best, w) => (Math.abs(w - 400) < Math.abs(best - 400) ? w : best), list[0]);
  const boldCandidates = list.filter((w) => w >= 600 && w !== regular);
  const bold = list.includes(700) ? 700 : boldCandidates.length ? boldCandidates.reduce((best, w) => (Math.abs(w - 700) < Math.abs(best - 700) ? w : best), boldCandidates[0]) : null;
  return bold && bold !== regular ? [regular, bold] : [regular];
}

/** Fontsource CDN の WOFF2 URL（日本語サブセット）。 */
export function fontWoff2Url(fontId, weight) {
  return `https://cdn.jsdelivr.net/fontsource/fonts/${fontId}@latest/japanese-${weight}-normal.woff2`;
}

// ---- CSS の font-family 分類 ----

const JAPANESE_FONT_RE = /\b(noto\s+(?:sans|serif)\s+jp|hiragino|yu\s*(?:gothic|mincho)|meiryo|ms\s*p?(?:gothic|mincho)|biz\s*udp?(?:gothic|mincho)|m\s*plus|mplus|ibm\s+plex\s+sans\s+jp|zen\s+(?:kaku|maru|old|antique|kurenaido)|shippori|sawarabi|kosugi|klee\s+one|line\s+seed\s+jp|ipa(?:ex)?(?:gothic|mincho)|takao|vl\s*gothic|source\s+han|dotgothic|tsukimi\s+rounded)\b|[ぁ-んァ-ヶ一-龥]/i;

const MONO_RE = /(?:^|[\s_-])(monospace|ui-monospace|mono|code|console|terminal|courier|consolas|menlo|monaco|fira\s*code|jetbrains|iosevka|inconsolata|hack|cascadia|sfmono|sf\s*mono|andale|dejavu\s+sans\s+mono|liberation\s+mono|ubuntu\s+mono|tui)(?:$|[\s_-])/i;

const ROUNDED_RE = /(?:^|[\s_-])(rounded|ui-rounded|nunito|quicksand|fredoka|varela\s*round|comfortaa|baloo|rubik|comic\s*sans)(?:$|[\s_-])/i;

const SERIF_RE = /(?:^|[\s_-])(ui-serif|georgia|times|garamond|merriweather|playfair|lora|baskerville|caslon|crimson|palatino|cambria|charter|bookman|didot|bodoni|newsreader|literata|spectral|bitter|vollkorn|pt\s*serif|source\s*serif|noto\s*serif)(?:$|[\s_-])/i;

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong']);

/** CSS の font-family 文字列をカンマ区切りのファミリー名配列へ分解する。 */
export function parseFontFamily(fontFamily) {
  if (!fontFamily || typeof fontFamily !== 'string') return [];
  return fontFamily
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').trim())
    .filter(Boolean);
}

/** 元の CSS にすでに日本語フォントが明示指定されているか。 */
export function hasJapaneseFont(fontFamily) {
  return parseFontFamily(fontFamily).some((name) => JAPANESE_FONT_RE.test(name));
}

/**
 * 元の CSS の font-family 文字列から系統を判定する。
 * 返す値：{ category: 'sans'|'mono'|'serif'|'rounded'|null, ambiguous: boolean }
 * - 日本語フォントがすでに入っていれば category: null（サイトの指定を保つ）。
 * - ambiguous が true のときは、名前に手がかりが無い独自フォントが先頭にあるため、
 *   ページ側で Canvas 実測による等幅チェックを行うと精度が上がる。
 */
export function classifyFontFamily(fontFamily) {
  const names = parseFontFamily(fontFamily);
  if (names.length === 0) return { category: 'sans', ambiguous: false };
  if (names.some((name) => JAPANESE_FONT_RE.test(name))) return { category: null, ambiguous: false };

  let decided = null;
  for (const raw of names) {
    const lower = raw.toLowerCase();
    if (lower === 'monospace' || lower === 'ui-monospace' || MONO_RE.test(lower)) {
      decided = 'mono';
      break;
    }
    if (lower === 'ui-rounded' || ROUNDED_RE.test(lower)) {
      decided = 'rounded';
      break;
    }
    if (lower === 'serif' || lower === 'ui-serif' || (SERIF_RE.test(lower) && !/sans-serif/.test(lower))) {
      decided = 'serif';
      break;
    }
    if (lower === 'sans-serif' || lower === 'ui-sans-serif' || lower === 'system-ui') {
      decided = 'sans';
      break;
    }
  }

  const first = names[0].toLowerCase();
  const ambiguous = (decided === null || decided === 'sans') && !GENERIC_FAMILIES.has(first);
  return { category: decided ?? 'sans', ambiguous };
}
