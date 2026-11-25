// 設定の既定値と選択肢。Service Worker・ボタンのメニュー・設定画面・テキスト翻訳で共有する。

import { DEFAULT_PAGE_FONTS } from './fonts.js';
import { DEFAULT_TARGET, LANGUAGES, TARGETS } from './languages.js';

/**
 * chrome.storage.sync に置く設定（Brave の同期で、ほかのPCとそろう）。
 * model：'0.8B'（既定。速い）・'2B'（訳が正確、約3倍遅い）。
 * idleMinutes：この分数使わなければモデルを解放する（0 は解放しない）。
 * mode：訳したときの表示。'trans'（訳文だけ）・'both'（原文と訳文を並べる）。
 * selectionIcon：文章を選んだときに「訳」アイコンを出すか。
 * debugLog：調査用のログを残すか（ページ・Service Worker・モデルの出来事。設定画面から保存できる）。
 * target：訳文の言語（shared/languages.js のコード）。ページの翻訳・選択範囲の訳で使い、PDF翻訳の画面の既定にする。テキスト翻訳はその画面で選ぶ。
 * pageFonts：ページ翻訳で使う日本語フォント（4系統ごとの Fontsource ID と有効・無効）。訳文が日本語のときだけ使う。
 */
export const DEFAULTS = { theme: 'system', form: 'polite', source: '', target: DEFAULT_TARGET, mode: 'trans', model: '0.8B', idleMinutes: 10, debugLog: false, selectionIcon: true, pageFonts: DEFAULT_PAGE_FONTS };

// 既定の同時実行数を変えるときはここだけを変える。保存済みのPCごとの値は引き継ぐ。
// 2026-11-10、作者の判断で8本にした。自前ビルドの wllama では、8本が全体の時間も最初の訳も現行の4本より速い（docs/09_性能の仮説検証.md「最終の通算」）。
export const DEFAULT_PARALLEL = 8;

/**
 * chrome.storage.local に置く、PCの性能に合わせる設定（同期しない。検証環境Bの内蔵GPUと検証環境Aの単体GPUで合う値が違うため）。
 * device：'auto'（WebGPU が使えれば GPU、読み込めなければ CPU）・'gpu'・'cpu'。threads：CPU のスレッド数（0 は自動＝論理コアの半分）。
 * parallel：ページの翻訳で同時に送るバッチの数。モデルはこれより1本多く同時に計算できるように読み込み、1本を選択範囲・テキスト翻訳に空ける。
 * ubatch：原文を読み込むときに GPU へ一度に渡すトークン数（llama.cpp の n_ubatch）。大きいほど GPU を使い切れるが、メモリーを多く使う。
 */
export const LOCAL_DEFAULTS = { device: 'auto', threads: 0, parallel: DEFAULT_PARALLEL, ubatch: 512 };

/**
 * 調整の選択肢。設定画面と、読み込むときの値の点検で使う。
 * 16本は GPU に余裕のあるPC向け（検証環境Aの RTX 4060 の実際のページで全体 -16%、最初の行 約+70ms。2026-11-11）。
 * 最初の行が遅れるので、「このPCに合わせる」の自動の候補には入れず（AUTO_PARALLEL_MAX）、作者が選ぶ。
 */
export const PARALLEL_CHOICES = [1, 2, 3, 4, 6, 8, 16];
export const AUTO_PARALLEL_MAX = 8;
export const UBATCH_CHOICES = [128, 256, 512, 1024, 2048];

/** 保存された値を、選択肢の中の数にそろえる（古い値や手で入れた値で読み込みに失敗しないように）。 */
export function normalizeLocal(s) {
  const pick = (v, list, def) => (list.includes(Number(v)) ? Number(v) : def);
  return {
    device: ['auto', 'gpu', 'cpu'].includes(s.device) ? s.device : LOCAL_DEFAULTS.device,
    threads: Math.max(0, Number(s.threads) || 0),
    parallel: pick(s.parallel, PARALLEL_CHOICES, LOCAL_DEFAULTS.parallel),
    ubatch: pick(s.ubatch, UBATCH_CHOICES, LOCAL_DEFAULTS.ubatch),
  };
}

export const MODEL_LABELS = {
  '0.8B': '0.8B（速い。初回に約570MBを取得）',
  '2B': '2B（訳が正確。約3倍遅い。初回に約1.8GBを取得）',
};

/** 原文の言語の選択（select 要素）に、自動と52言語（日本語を除く）を入れる。 */
export function fillLanguages(select, autoLabel = '自動（段落ごとにモデルが判定する）') {
  select.append(new Option(autoLabel, ''));
  for (const [code, label] of LANGUAGES) select.append(new Option(label, code));
}

/** 訳文の言語の選択（select 要素）に言語を入れる。list を渡すとその言語だけ（PDF の訳文に選べる言語など）。 */
export function fillTargets(select, list = TARGETS) {
  for (const [code, label] of list) select.append(new Option(label, code));
}

/** モデルの状態を短い文にする（ボタンのメニュー・設定画面で使う）。 */
export function describeStatus(s) {
  if (s?.loading) return `${s.loading} を読み込み中です`;
  if (!s?.loaded) return 'モデルは読み込んでいません（訳すときに読み込みます）';
  const how = s.device === 'cpu' ? `CPU・${s.threads}スレッド` : `GPU${s.adapter ? `：${s.adapter}` : ''}・同時${s.parallel}件・ubatch ${s.ubatch}`;
  let text = `${s.loaded} を読み込み済み（${how}）`;
  if (s.idleMinutes && s.lastUse) {
    const left = Math.ceil((s.lastUse + s.idleMinutes * 60_000 - Date.now()) / 60_000);
    text += left > 0 ? `。あと約${left}分使わなければ解放します` : '。まもなく解放します';
  }
  return text;
}
