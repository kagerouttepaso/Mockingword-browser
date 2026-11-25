// PLaMo 3 Translate が扱う53言語の正本。言語のコード・表示名と、言語ごとの文字の規則（その言語で書かれた文か、訳文がその言語の文字か）、
// 右から左へ書くか、PDF へ書くフォントを置く。DOM にも chrome にも触れない純粋なモジュール（tools/unit.test.mjs で確かめる）。
// 設定画面・テキスト翻訳・ページ側・PDF の翻訳がここから読む。設計は docs/03_翻訳コア.md「訳文の言語」。

const script = (...names) => new RegExp(`[${names.map((n) => `\\p{Script=${n}}`).join('')}]`, 'u');

const LATIN = script('Latin');
const CYRILLIC = script('Cyrillic');
const ARABIC = script('Arabic');
const DEVANAGARI = script('Devanagari');
const KANA = /[぀-ヿ]/u;
const HANGUL = script('Hangul');
const HAN = script('Han');

/**
 * 言語の一覧。code は PFML3 の lang に書くコード。並びは Androidアプリの Language.kt と同じ（日本語、よく使う4つ、残りは五十音順）。
 *   script：訳文がこの言語の文字で書かれているかの判定（まとめ訳しで原文のまま返った行を見つける。shared/text.js の untranslated）
 *   own：この言語だけが使う文字。含む文はもうこの言語で書かれているとみなし、訳さない（日本語のかな、ハングル、タイ文字など）。
 *     ラテン文字・キリル文字・アラビア文字・デーヴァナーガリーのように複数の言語が使う文字では決められないので持たない。
 *   not：own を含んでも、この文字を含めばこの言語ではない（中国語の漢字だけの文と、かな・ハングルの混ざる日本語・韓国語を分ける）
 *   rtl：右から左へ書く。pdf：PDF へ書く訳文のフォント（pdf/fonts.js）。無い言語は PDF の訳文の言語に選べない
 *     （PDFium は文字の並べ替え・字形の組み合わせをしないので、右から左の言語と、字形を組み合わせて書く文字は正しく書けない）。
 */
const TABLE = [
  ['ja', '日本語', { script: script('Han', 'Hiragana', 'Katakana'), own: KANA, pdf: 'jp' }],
  ['ko', '韓国語', { script: HANGUL, own: HANGUL, pdf: 'kr' }],
  ['en', '英語', { script: LATIN, pdf: 'latin' }],
  ['zh-hans', '中国語（簡体字）', { script: HAN, own: HAN, not: /[぀-ヿ\p{Script=Hangul}]/u, pdf: 'sc' }],
  ['zh-hant', '中国語（繁体字）', { script: HAN, own: HAN, not: /[぀-ヿ\p{Script=Hangul}]/u, pdf: 'tc' }],
  ['az', 'アゼルバイジャン語', { script: script('Latin', 'Cyrillic'), pdf: 'latin' }],
  ['ar', 'アラビア語', { script: ARABIC, rtl: true }],
  ['hy', 'アルメニア語', { script: script('Armenian'), own: script('Armenian') }],
  ['it', 'イタリア語', { script: LATIN, pdf: 'latin' }],
  ['id', 'インドネシア語', { script: LATIN, pdf: 'latin' }],
  ['uz', 'ウズベク語', { script: script('Latin', 'Cyrillic'), pdf: 'latin' }],
  ['ur', 'ウルドゥー語', { script: ARABIC, rtl: true }],
  ['et', 'エストニア語', { script: LATIN, pdf: 'latin' }],
  ['nl', 'オランダ語', { script: LATIN, pdf: 'latin' }],
  ['kk', 'カザフ語', { script: script('Cyrillic', 'Latin'), pdf: 'latin' }],
  ['ca', 'カタルーニャ語', { script: LATIN, pdf: 'latin' }],
  ['km', 'クメール語', { script: script('Khmer'), own: script('Khmer') }],
  ['gu', 'グジャラート語', { script: script('Gujarati'), own: script('Gujarati') }],
  ['hr', 'クロアチア語', { script: LATIN, pdf: 'latin' }],
  ['jv', 'ジャワ語', { script: LATIN, pdf: 'latin' }],
  ['ka', 'ジョージア語', { script: script('Georgian'), own: script('Georgian') }],
  ['si', 'シンハラ語', { script: script('Sinhala'), own: script('Sinhala') }],
  ['es', 'スペイン語', { script: LATIN, pdf: 'latin' }],
  ['sk', 'スロバキア語', { script: LATIN, pdf: 'latin' }],
  ['sl', 'スロベニア語', { script: LATIN, pdf: 'latin' }],
  ['sw', 'スワヒリ語', { script: LATIN, pdf: 'latin' }],
  ['ceb', 'セブアノ語', { script: LATIN, pdf: 'latin' }],
  ['sr', 'セルビア語', { script: script('Cyrillic', 'Latin'), pdf: 'latin' }],
  ['th', 'タイ語', { script: script('Thai'), own: script('Thai') }],
  ['tl', 'タガログ語', { script: LATIN, pdf: 'latin' }],
  ['ta', 'タミル語', { script: script('Tamil'), own: script('Tamil') }],
  ['te', 'テルグ語', { script: script('Telugu'), own: script('Telugu') }],
  ['de', 'ドイツ語', { script: LATIN, pdf: 'latin' }],
  ['ne', 'ネパール語', { script: DEVANAGARI }],
  ['hu', 'ハンガリー語', { script: LATIN, pdf: 'latin' }],
  ['eu', 'バスク語', { script: LATIN, pdf: 'latin' }],
  ['pa', 'パンジャブ語', { script: script('Gurmukhi'), own: script('Gurmukhi') }],
  ['hi', 'ヒンディー語', { script: DEVANAGARI }],
  ['my', 'ビルマ語', { script: script('Myanmar'), own: script('Myanmar') }],
  ['fr', 'フランス語', { script: LATIN, pdf: 'latin' }],
  ['bg', 'ブルガリア語', { script: CYRILLIC, pdf: 'latin' }],
  ['he', 'ヘブライ語', { script: script('Hebrew'), own: script('Hebrew'), rtl: true }],
  ['vi', 'ベトナム語', { script: LATIN, pdf: 'latin' }],
  ['fa', 'ペルシア語', { script: ARABIC, rtl: true }],
  ['be', 'ベラルーシ語', { script: CYRILLIC, pdf: 'latin' }],
  ['bn', 'ベンガル語', { script: script('Bengali'), own: script('Bengali') }],
  ['pl', 'ポーランド語', { script: LATIN, pdf: 'latin' }],
  ['mr', 'マラーティー語', { script: DEVANAGARI }],
  ['ml', 'マラヤーラム語', { script: script('Malayalam'), own: script('Malayalam') }],
  ['ms', 'マレー語', { script: LATIN, pdf: 'latin' }],
  ['lv', 'ラトビア語', { script: LATIN, pdf: 'latin' }],
  ['lt', 'リトアニア語', { script: LATIN, pdf: 'latin' }],
  ['ru', 'ロシア語', { script: CYRILLIC, pdf: 'latin' }],
];

const BY_CODE = new Map(TABLE.map(([code, label, rule]) => [code, { code, label, ...rule }]));

/** 既定の訳文の言語。 */
export const DEFAULT_TARGET = 'ja';

/** 訳文に選べる言語（53言語）。[code, 表示名] の並び。 */
export const TARGETS = TABLE.map(([code, label]) => [code, label]);

/** 原文の言語に選べる言語。日本語を除く52言語（日本語は画面ごとに足す）。 */
export const LANGUAGES = TARGETS.filter(([code]) => code !== 'ja');

/** PDF の訳文に選べる言語（PDF へ書くフォントのある言語）。 */
export const PDF_TARGETS = TABLE.filter(([, , rule]) => rule.pdf).map(([code, label]) => [code, label]);

const entry = (code) => BY_CODE.get(code) ?? BY_CODE.get(DEFAULT_TARGET);

/** 保存された訳文の言語を、一覧にあるコードにそろえる（無い値は日本語）。 */
export function normalizeTarget(code) {
  return BY_CODE.has(code) ? code : DEFAULT_TARGET;
}

/** 言語の表示名（「英語」など）。 */
export const languageLabel = (code) => entry(code).label;

/** HTML の lang に書く言語タグ（zh-hans → zh-Hans）。 */
export const langTag = (code) => entry(code).code.replace(/-(han[st])$/, (_, s) => `-${s[0].toUpperCase()}${s.slice(1)}`);

/** 右から左へ書く言語か。 */
export const isRtl = (code) => !!entry(code).rtl;

/** PDF へ書く訳文のフォントの種類（pdf/fonts.js の鍵）。PDF の訳文に選べない言語は null。 */
export const pdfFontOf = (code) => BY_CODE.get(code)?.pdf ?? null;

/** 文がもう target の言語で書かれているか（その言語だけが使う文字を含む）。決められない言語では false。 */
export function writtenOnlyIn(text, target) {
  const { own, not } = entry(target);
  return !!own && own.test(text) && !(not && not.test(text));
}

/** 訳文が target の言語の文字を含むか。 */
export function hasScriptOf(text, target) {
  return entry(target).script.test(text);
}
