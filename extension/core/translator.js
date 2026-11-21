// 何をどうまとめて訳すかを決める。キャッシュ（core/cache.js）を先に引き、残りをモデル（core/engine.js）へ送る。
// 手本は Androidアプリの BatchTranslator.kt。設計は docs/03_翻訳コア.md「まとめ訳し」。

import { cacheKey, lookup, remember } from './cache.js';
import { complete } from './engine.js';
import { chunk, splitLong, untranslated } from '../shared/text.js';

/** 長い1段落はこの字数ごとに文の切れ目で分けて訳す。 */
const LONG_TEXT = 1200;

/** 原文の並びのうち、キャッシュにある訳を返す（無いものは null）。ページが訳し始める前に、キャッシュの分をまとめて置き換えるため。 */
export async function lookupCached(texts, options) {
  return (await lookup(texts.map((t) => cacheKey(t, options)))).map((v) => v ?? null);
}

/**
 * 1つの文章を訳す。長ければ文の切れ目で分けて訳し、つなげて返す。stats を渡すと、生成したトークン数を足す。
 * 片は同時に送る。モデルは同時実行数分を同時に計算できるので、n 片が約 n 倍ではなく約1片ぶんの時間で済む
 * （sakutto の長い段落の片を空いた同時実行数へ散らす工夫。docs/09 S3）。あふれた片はOffscreen Documentが順番に待たせる。
 */
export async function translateText(text, options, stats = null) {
  const key = cacheKey(text, options);
  const [hit] = await lookup([key]);
  if (hit !== undefined) return hit;
  const parts = splitLong(text, LONG_TEXT);
  const sep = parts.length > 1 ? ' ' : '';
  // onText：訳文の途中（片ごとの途中をつないだもの）を受け取る（テキスト翻訳の逐次表示）。
  const live = parts.map(() => '');
  const out = await Promise.all(parts.map(async (part, k) => {
    const onPartial = options.onText ? (t) => { live[k] = t; options.onText(live.filter(Boolean).join(sep)); } : undefined;
    // 分割した段落の途中表示には先頭の片を使う。後の片が先にできても文頭から順に表示する。
    const r = await complete(part, { ...options, onPartial, pageRows: k === 0 ? options.pageRows : undefined });
    if (stats) {
      stats.tokens += r.tokens ?? 0;
      stats.loadMs = Math.max(stats.loadMs, r.loadMs ?? 0);
    }
    return r.text;
  }));
  const joined = out.join(sep);
  remember(key, joined);
  return joined;
}

/**
 * 数行（1行＝1段落）をまとめて1回で訳し、訳文を改行で分けて行ごとに返す。
 * PLaMo は改行を保ったまま訳すので、1回あたりの固定費（プロンプト処理）をまとめて払える。
 * 行数が合わない・生成を打ち切ったときはバッチを1行ずつ、訳されていない行（shared/text.js の untranslated）はその行だけ訳し直す。
 */
export async function translateBatch(texts, options) {
  const results = new Array(texts.length);
  // tokens：モデルが生成したトークン数（キャッシュから返した分は0）。loadMs：モデルの読み込みを待った時間の最長。
  // ページのバーが速さ（トークン/秒）を出すのに使う。
  const stats = { requests: 0, fallback: false, tokens: 0, loadMs: 0 };
  const hits = await lookup(texts.map((t) => cacheKey(t, options)));
  const pending = [];
  texts.forEach((_, i) => (hits[i] !== undefined ? (results[i] = hits[i]) : pending.push(i)));
  if (pending.length === 0) return { results, stats };

  // onLines(i, 訳文の途中)：行ごとの途中を受け取る（テキスト翻訳の逐次表示）。
  const one = async (i, preview) => {
    const onText = options.onLines ? (t) => options.onLines(i, t) : undefined;
    const pageRows = options.requestId && preview ? [i] : undefined;
    results[i] = await translateText(texts[i], { ...options, onText, pageRows }, stats);
    stats.requests++;
  };
  // 1行だけ、または長い段落を含むときは1行ずつ訳す。長い段落の片は translateText の中で同時に送る。
  if (pending.length === 1 || pending.some((i) => texts[i].length > LONG_TEXT)) {
    for (const i of pending) await one(i, true);
    return { results, stats };
  }

  const onPartial = options.onLines ? (t) => t.split('\n').slice(0, pending.length).forEach((l, k) => options.onLines(pending[k], l.trim())) : undefined;
  const r = await complete(pending.map((i) => texts[i]).join('\n'), { ...options, pageRows: options.requestId ? pending : undefined, onPartial });
  stats.requests++;
  stats.tokens += r.tokens ?? 0;
  stats.loadMs = Math.max(stats.loadMs, r.loadMs ?? 0);
  const lines = r.text.split('\n').map((l) => l.trim());
  const redo = [];
  // 打ち切った訳文（r.cut）は、行数が合っても行と段落の対応を信用しない。行の出しすぎは先頭から送った行数で切るので、
  // モデルが1段落を2行以上に分けて返すと、以降の訳が1段落ずつずれ、最後の段落の訳が抜けたまま行数だけが合う
  // （2026-11-13、モデルの出力を差し替えた再現で確認。見た目では訳が付いているので気づけない）。
  if (!r.cut && lines.length === pending.length) {
    pending.forEach((i, k) => {
      if (untranslated(texts[i], lines[k], options.target)) return redo.push(i);
      results[i] = lines[k];
      remember(cacheKey(texts[i], options), lines[k]);
    });
  } else {
    stats.fallback = true; // 行がずれた・打ち切ったら、このバッチは1つずつ訳し直す
    redo.push(...pending);
  }
  for (const i of redo) await one(i);
  return { results, stats };
}

/**
 * 複数行の文章（テキスト翻訳）を訳す。行ごとに分け、ページの翻訳と同じく8行・400字までまとめて訳す。
 * 1つのリクエストに言語を混ぜると2言語目以降の行を原文のまま返すことがあるため、まとめ訳しの行ごとの点検を通す。
 * バッチは同時に送り（モデルは5本まで同時に計算できる）、空行は保つ。
 */
export async function translateLines(text, options) {
  const lines = text.split(/\r?\n/);
  const items = lines.map((l, i) => ({ i, text: l.trim() })).filter((x) => x.text);
  const out = [...lines];
  // onUpdate(訳文の途中)：まだ訳していない行は空にして、訳し始めた行から出す（テキスト翻訳の逐次表示）。
  const shown = lines.map((l) => (l.trim() ? '' : l));
  const show = (i, t) => {
    shown[i] = t;
    options.onUpdate(shown.join('\n').trimEnd());
  };
  await Promise.all(chunk(items).map(async (group) => {
    const onLines = options.onUpdate ? (k, t) => show(group[k].i, t) : undefined;
    const { results } = await translateBatch(group.map((x) => x.text), onLines ? { ...options, onLines } : options);
    group.forEach((x, k) => {
      out[x.i] = results[k];
      if (options.onUpdate) show(x.i, results[k]);
    });
  }));
  return out.join('\n');
}
