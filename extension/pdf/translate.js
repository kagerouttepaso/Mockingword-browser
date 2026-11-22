// PDF の翻訳の流れ（PDF翻訳のページの Worker で動く。pdf/worker.js）：開く → 段落を読む → 訳す（見ているページから）→
// ページの段落がそろったらそのページを訳したPDFへ書く → 書いたページを画面へ渡す（版）。保存するときは同じ訳したPDFを仕上げる。
// 生成中の訳文は画面の途中表示へ渡す。訳す処理は呼び出し側が渡す（docs/12_PDFの翻訳.md「データの流れ」）。
import { decode, previewLine, remainingSource } from '../shared/markup.js';
import { addBackgrounds } from './background.js';
import { extractParagraphs } from './extract.js';
import { finishPdf } from './finish.js';
import { loadFonts, measureWithFonts } from './fonts.js';
import { paragraphBox, paragraphGeometry } from './plan.js';
import { openPdf } from './pdfium.js';
import { createPdfQueue, paragraphsByPage } from './queue.js';
import { titleTranslations } from './titles.js';
import { embedFonts, newStats, piecesOf, prepare, writePageAt } from './write.js';

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
export async function openPdfJob(bytes, { onFontProgress, onFontsReady } = {}) {
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
  fonts.then(() => onFontsReady?.(), () => {}); // 失敗は使う側の await で受ける
  const pages = paragraphsByPage(paras);
  const queue = createPdfQueue(pages);
  const byText = new Map();
  for (const p of paras) {
    if (p.skip) continue;
    if (!byText.has(p.text)) byText.set(p.text, []);
    byText.get(p.text).push(p);
  }
  const translations = new Map();
  const stats = newStats();
  let handles = null;
  let doneChars = 0;
  let controller = null;

  return {
    paras,
    close: () => doc.close(),
    /**
     * 訳す。
     *   translate(texts, signal, onPartial) → 訳文の配列（マーカー付きの1行を渡し、同じ順に返す）
     *   parallel：同時に頼む翻訳の最大数
     *   focus() → 今見ているページの番号（そこに近いページの段落から訳す）
     *   onStage({ stage, done, total }) → 進み具合（stage は 'translate'）
     *   onStatus(段落の配列, 状態) → 段落の状態：'working'（訳している）・'done'（訳文がそろった）・null（訳さずに原文を残す）。
     *     どの段落にも背景色 p.background が付いている
     *   onPreview([{ id, pieces }]) → 段落の途中表示。空の pieces は訳し直しのために途中表示を取り下げる
     *   onVersion({ bytes, pages }) → 訳したPDF（その時点の全体）と、この版で新しく書いたページの番号
     *   onTitles(見出しの鍵 → 訳した見出し) → 訳し終えた段落から作った見出しの訳（pdf/titles.js）
     * 返す値：書いた段落などの件数と時間（ミリ秒）。
     */
    async run({ translate, parallel, focus = () => 0, onStage = () => {}, onStatus = () => {}, onPreview = () => {}, onVersion = () => {}, onTitles = () => {} }) {
      if (!queue.total) throw new Error('訳せる文章が見つかりませんでした（画像だけのPDFなど）');
      if (controller) throw new Error('すでに翻訳しています');
      controller = new AbortController();
      const ms = { read: readMs, translate: 0, write: 0, save: 0 };
      const written = []; // 書いたが、まだ版にしていないページ
      let lastVersion = -Infinity, lastSave = 0;
      const emit = () => {
        if (!written.length) return;
        const t = performance.now();
        const out = doc.save();
        lastSave = performance.now() - t;
        ms.save += lastSave;
        onVersion({ bytes: out, pages: written.splice(0) });
        lastVersion = performance.now();
      };
      const writeFinished = async (finished) => {
        const loaded = await fonts;
        handles ??= embedFonts(doc, loaded);
        const measure = measureWithFonts(loaded);
        const t = performance.now();
        for (const pi of finished) {
          const all = pages.get(pi);
          const mine = prepare(all, translations);
          if (!mine.length) continue; // 訳文が原文と同じ段落だけのページは原文のまま
          writePageAt(doc, pi, all, mine, handles, measure, stats);
          written.push(pi);
        }
        ms.write += performance.now() - t;
        if (performance.now() - lastVersion >= Math.max(VERSION_INTERVAL, lastSave * SAVE_SHARE)) emit();
      };
      const started = performance.now();
      const active = new Set();
      let writing = Promise.resolve();
      let writeError = null;
      let stopped;
      try {
        onStage({ stage: 'translate', done: doneChars, total: queue.chars });
        stopped = await queue.run({
          parallel, focus, signal: controller.signal,
          translate(part, signal) {
            const working = part.flatMap((text) => byText.get(text));
            const touched = new Set(working.map((p) => p.page));
            addBackgrounds(doc, [...touched].flatMap((pi) => pages.get(pi).filter((p) => !p.skip)), paragraphBox);
            for (const p of working) {
              p.geometry ??= paragraphGeometry(p, pages.get(p.page));
              active.add(p);
            }
            onStatus(working, 'working');
            return translate(part, signal, (lines) => {
              if (signal.aborted) return;
              const updates = lines.flatMap(({ i, text, complete }) => {
                const sentences = complete || !text ? 0 : previewLine(text).sentences;
                return byText.get(part[i]).filter((p) => active.has(p)).map((p) => {
                  const pieces = text ? piecesOf(p, decode(text, p.kinds)) : [];
                  if (pieces.length && !complete) {
                    const tail = piecesOf(p, remainingSource(p.text, p.kinds, sentences));
                    if (tail.length) pieces.push({ text: ' ', bold: p.bold, source: true }, ...tail.map((piece) => ({ ...piece, source: true })));
                  }
                  return { id: p.id, pieces };
                });
              });
              if (updates.length) onPreview(updates);
            });
          },
          onResult(part, results, finished) {
            part.forEach((text, index) => {
              if (results[index]) translations.set(text, results[index]);
              doneChars += text.length;
            });
            const working = part.flatMap((text) => byText.get(text));
            for (const p of working) active.delete(p);
            const done = prepare(working, translations);
            const doneSet = new Set(done);
            onStatus(done, 'done');
            onStatus(working.filter((p) => !doneSet.has(p)), null);
            onTitles(titleTranslations(done));
            onStage({ stage: 'translate', done: doneChars, total: queue.chars });
            if (finished.length) {
              writing = writing.then(() => {
                if (!writeError) return writeFinished(finished);
              }).catch((error) => {
                writeError = error;
                controller.abort();
              });
            }
          },
        });
      } finally {
        controller.abort();
        await writing;
        controller = null;
        onStatus([...active], null);
        emit();
      }
      if (writeError) throw writeError;
      ms.translate = performance.now() - started - ms.write - ms.save;
      stats.same = paras.filter((p) => p.skip === 'same').length;
      for (const k of Object.keys(ms)) ms[k] = Math.round(ms[k]);
      return { ...stats, paragraphs: queue.total, ms, stopped };
    },
    /** 訳すのを止める。頼んでいる分の結果を待たずに run を終える（呼び出し側が翻訳も取り消す）。もう一度 run を呼ぶと続きから訳す。 */
    stop() { controller?.abort(); },
    /** 今の訳したPDF（画面に出しているもの）を保存する形に仕上げる。返す値：{ bytes, outline, encrypted, inBytes, outBytes }。 */
    async save() {
      const out = doc.save();
      const result = handles ? await finishPdf(out, prepare(paras, translations), await fonts) : { bytes: out, outline: 0, encrypted: false };
      return { ...result, inBytes: doc.size, outBytes: result.bytes.length };
    },
  };
}
