// PDF の翻訳の流れ（PDF翻訳のページの Worker で動く。pdf/worker.js）：開く → 段落を読む → 訳す（見ているページから）→
// ページの段落がそろったらそのページを訳したPDFへ書く → 書いたページを画面へ渡す（版）。保存するときは同じ訳したPDFを仕上げる。
// 訳したPDFは1つで、画面に出すものと保存するものは同じ（docs/12_PDFの翻訳.md「データの流れ」）。訳す処理は呼び出し側が渡す。
import { addBackgrounds } from './background.js';
import { extractParagraphs } from './extract.js';
import { finishPdf } from './finish.js';
import { loadFonts } from './fonts.js';
import { paragraphBox } from './plan.js';
import { openPdf } from './pdfium.js';
import { titleTranslations } from './titles.js';
import { embedFonts, newStats, prepare, writePageAt } from './write.js';

/** 1回に頼む段落の数。小さいほど訳文が早く画面に出る。Service Worker がモデルの同時実行数へ振り分ける。 */
const BATCH = 8;
/**
 * 版（書いたページを画面へ渡す訳したPDF）を作る間隔。版を作るたびに文書全体を保存し、pdf.js が読み直す（300ページ・18MB で
 * 保存に約0.6秒）。訳し終えたページが続けて出るときはまとめて1つの版にし、保存にかかった時間の SAVE_SHARE 倍は空けて、
 * 保存が Worker の時間を占めないようにする（大きい PDF ほど版をまとめる）。
 */
const VERSION_INTERVAL = 1500;
const SAVE_SHARE = 4;

/**
 * PDF を開いて訳す準備をする。返す値：
 *   paras（段落。pdf/extract.js。p.id は段落の番号）・run(...)・save()・close()
 * onFontProgress(読んだバイト数, 全体) でフォントの取得の進み具合を知らせる。
 */
export async function openPdfJob(bytes, { onFontProgress } = {}) {
  const doc = await openPdf(bytes);
  const t0 = performance.now();
  let paras;
  try {
    paras = extractParagraphs(doc);
  } catch (e) {
    doc.close();
    throw e;
  }
  paras.forEach((p, i) => { p.id = i; });
  const readMs = Math.round(performance.now() - t0);
  const fonts = loadFonts(onFontProgress);
  fonts.catch(() => {}); // 失敗は使う側の await で受ける
  // 訳す文（同じ文は1回だけ訳す）と、その文があるページ。ページごとの、訳し終えていない文
  const pagesOf = new Map();
  const left = new Map();
  for (const p of paras) {
    if (p.skip) continue;
    if (!pagesOf.has(p.text)) pagesOf.set(p.text, new Set());
    pagesOf.get(p.text).add(p.page);
    if (!left.has(p.page)) left.set(p.page, new Set());
    left.get(p.page).add(p.text);
  }
  const translations = new Map();
  const stats = newStats();
  let handles = null;
  // 訳し残しの文と進み具合（中止して run を呼び直すと続きから訳す）
  const pending = new Set(pagesOf.keys());
  const chars = [...pending].reduce((sum, t) => sum + t.length, 0);
  let doneChars = 0;
  let stopped = false;

  return {
    paras,
    close: () => doc.close(),
    /**
     * 訳す。
     *   translate(texts) → 訳文の配列（マーカー付きの1行を渡し、同じ順に返す）
     *   focus() → 今見ているページの番号（そこに近いページの段落から訳す）
     *   onStage({ stage, done, total }) → 進み具合（stage は 'translate'）
     *   onStatus(段落の配列, 状態) → 段落の状態：'working'（訳している）・'done'（訳文がそろった）・null（訳さずに原文を残す）。
     *     どの段落にも背景色 p.background が付いている
     *   onVersion({ bytes, pages }) → 訳したPDF（その時点の全体）と、この版で新しく書いたページの番号
     *   onTitles(見出しの鍵 → 訳した見出し) → 訳し終えた段落から作った見出しの訳（pdf/titles.js）
     * 返す値：書いた段落などの件数と時間（ミリ秒）。
     */
    async run({ translate, focus = () => 0, onStage = () => {}, onStatus = () => {}, onVersion = () => {}, onTitles = () => {} }) {
      if (!pagesOf.size) throw new Error('訳せる文章が見つかりませんでした（画像だけのPDFなど）');
      const ms = { read: readMs, translate: 0, write: 0, save: 0 };
      stopped = false;
      const written = []; // 書いたが、まだ版にしていないページ
      let lastVersion = 0, lastSave = 0;
      const emit = () => {
        if (!written.length) return;
        const t = performance.now();
        const out = doc.save();
        lastSave = performance.now() - t;
        ms.save += lastSave;
        onVersion({ bytes: out, pages: written.splice(0) });
        lastVersion = performance.now();
      };
      /** 訳し終えた文のページのうち、全部の文がそろったページを書く。 */
      const writeFinished = async (texts) => {
        const finished = new Set();
        for (const text of texts) {
          for (const pi of pagesOf.get(text)) {
            const rest = left.get(pi);
            rest.delete(text);
            if (!rest.size) finished.add(pi);
          }
        }
        if (!finished.size) return;
        const loaded = await fonts;
        handles ??= embedFonts(doc, loaded);
        const measure = (s, bold, size) => loaded[bold ? 'bold' : 'regular'].measure(s, size);
        const todo = prepare(paras, translations);
        const t = performance.now();
        for (const pi of [...finished].sort((a, b) => a - b)) {
          const mine = todo.filter((p) => p.page === pi);
          if (!mine.length) continue; // 訳文が原文と同じ段落だけのページは原文のまま
          writePageAt(doc, pi, paras.filter((p) => p.page === pi), mine, handles, measure, stats);
          written.push(pi);
        }
        ms.write += performance.now() - t;
        if (performance.now() - lastVersion >= Math.max(VERSION_INTERVAL, lastSave * SAVE_SHARE)) emit();
      };
      onStage({ stage: 'translate', done: doneChars, total: chars });
      const started = performance.now();
      /** 今見ているページに近い文を BATCH 件取り出して頼む（見ているページより前のページは少し後回し）。 */
      const ask = () => {
        const f = focus();
        const distance = (t) => Math.min(...[...pagesOf.get(t)].map((pi) => (pi >= f ? pi - f : (f - pi) * 1.5)));
        const part = [...pending].sort((a, b) => distance(a) - distance(b)).slice(0, BATCH);
        for (const t of part) pending.delete(t);
        const asked = new Set(part);
        const working = paras.filter((p) => !p.skip && asked.has(p.text));
        // 背景色はページごとにまとめて、そのページを書く前の原文から取る（ページを描くのは1回だけ）
        const touched = new Set(working.map((p) => p.page));
        addBackgrounds(doc, paras.filter((p) => !p.skip && touched.has(p.page)), paragraphBox);
        onStatus(working, 'working');
        const promise = translate(part).then((results) => ({ part, working, results }), (e) => { throw Object.assign(e, { part, working }); });
        promise.catch(() => {}); // 失敗は次の await で受ける（書いている間に失敗しても、処理されない失敗として扱わない）
        return promise;
      };
      // 訳文を受け取ったらすぐ次を頼み、モデルが訳している間にページを書いて版を作る（書く・保存する間も翻訳を止めない）
      let inflight = ask();
      while (inflight) {
        let reply;
        try {
          reply = await inflight;
        } catch (e) {
          if (!stopped) throw e;
          // 中止で取り消した分は訳し残しへ戻す（再開したときに訳す）
          for (const t of e.part ?? []) pending.add(t);
          onStatus(e.working ?? [], null);
          break;
        }
        const { part, working, results } = reply;
        inflight = pending.size && !stopped ? ask() : null;
        const fresh = new Set();
        part.forEach((t, k) => {
          if (results[k]) { translations.set(t, results[k]); fresh.add(t); }
          doneChars += t.length;
        });
        const done = prepare(paras, translations).filter((p) => fresh.has(p.text));
        const doneSet = new Set(done);
        onStatus(done, 'done');
        onStatus(working.filter((p) => !doneSet.has(p)), null);
        onTitles(titleTranslations(done));
        onStage({ stage: 'translate', done: doneChars, total: chars });
        await writeFinished(part);
      }
      emit();
      ms.translate = performance.now() - started - ms.write - ms.save;
      stats.same = paras.filter((p) => p.skip === 'same').length;
      for (const k of Object.keys(ms)) ms[k] = Math.round(ms[k]);
      return { ...stats, paragraphs: pagesOf.size, ms, stopped: stopped && pending.size > 0 };
    },
    /** 訳すのを止める。頼んでいる分の結果を待たずに run を終える（呼び出し側が翻訳も取り消す）。もう一度 run を呼ぶと続きから訳す。 */
    stop() { stopped = true; },
    /** 今の訳したPDF（画面に出しているもの）を保存する形に仕上げる。返す値：{ bytes, outline, encrypted, inBytes, outBytes }。 */
    async save() {
      const out = doc.save();
      const result = handles ? await finishPdf(out, prepare(paras, translations), await fonts) : { bytes: out, outline: 0, encrypted: false };
      return { ...result, inBytes: doc.size, outBytes: result.bytes.length };
    },
  };
}
