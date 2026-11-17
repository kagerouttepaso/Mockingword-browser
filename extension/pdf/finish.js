// 訳したPDF（画面に出しているもの）を保存する形に仕上げる：日本語フォントから使っていない字形を抜き、しおりを訳す。
// 字形の番号は保つ（pdf/subset.js の retainGids）ので、見た目は画面に出していた訳したPDFと変わらない。
// 暗号化された PDF（編集などを制限したもの）は pdf-lib で開けないので、フォントは丸ごとのまま、しおりは原文のまま保存する。
import { PDFDict, PDFDocument, PDFName, PDFNumber } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { translateOutline } from './outline.js';
import { subsetFont } from './subset.js';

// pdf-lib は既定で読み書きを数十オブジェクトごとにタイマーで区切る。画面が裏に回るとブラウザーがタイマーを間引き
// （1秒に1回）、20ページの PDF でも数十秒かかった。区切らずに一度で処理する（Infinity。pdf-lib の ParseSpeeds.Fastest と同じ値）。
const NO_TICKS = Infinity;

/**
 * bytes（PDFium が保存した訳したPDF）を仕上げる。paras は書いた段落（p.pieces のあるもの）、fonts は pdf/fonts.js の loadFonts の値。
 * 返す値：{ bytes, outline（訳したしおりの数）, encrypted }。
 */
export async function finishPdf(bytes, paras, fonts) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, parseSpeed: NO_TICKS });
  } catch (e) {
    if (/encrypted/i.test(e.message)) return { bytes, outline: 0, encrypted: true };
    throw e;
  }
  // 書体ごとに、訳文で使った文字
  const used = { regular: '', bold: '' };
  for (const p of paras) for (const x of p.pieces ?? []) used[x.bold ? 'bold' : 'regular'] += x.text;
  // 埋め込んだ日本語フォント（FontFile2 の Length1 が元のフォントの大きさと同じもの）を、使った字形だけのフォントに差し替える
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict) || obj.get(PDFName.of('Type')) !== PDFName.of('FontDescriptor')) continue;
    const ref = obj.get(PDFName.of('FontFile2'));
    const file = ref && doc.context.lookup(ref);
    const length1 = file?.dict?.get(PDFName.of('Length1'));
    if (!(length1 instanceof PDFNumber)) continue;
    const key = Object.keys(used).find((k) => fonts[k].bytes.byteLength === length1.asNumber());
    if (!key) continue;
    const subset = await subsetFont(fonts[key].bytes, used[key] || ' ', { retainGids: true });
    doc.context.assign(ref, doc.context.flateStream(subset, { Length1: subset.length }));
  }
  const outline = translateOutline(doc, paras);
  return { bytes: await doc.save({ useObjectStreams: false, objectsPerTick: NO_TICKS }), outline: outline.translated, encrypted: false };
}
