// PDFium（WASM）の読み込みと、文書を開く・保存する薄い包み。PDFium の C API を pdf/ の処理から呼びやすくする。
// WASM は1つだけ作り、文書ごとに開いて閉じる。FPDF_LoadMemDocument はバイト列を写さないので、閉じるまで確保したままにする。
import { init } from '../vendor/pdfium/pdfium.js';

let ready = null;

/** PDFium を読み込む（2回目からは同じものを返す）。 */
export function pdfium() {
  ready ??= (async () => {
    const wasmBinary = await (await fetch(new URL('../vendor/pdfium/pdfium.wasm', import.meta.url))).arrayBuffer();
    const P = await init({ wasmBinary });
    P.PDFiumExt_Init();
    return P;
  })();
  return ready;
}

/**
 * PDF を開く。返す値：
 *   P・M（C API とメモリー）、doc、malloc・free、作業用の領域 tmp と読み出し（d：double、f：float、u32）、save()・close()。
 */
export async function openPdf(bytes) {
  const P = await pdfium();
  const M = P.pdfium;
  const malloc = (n) => M.wasmExports.malloc(n);
  const free = (p) => M.wasmExports.free(p);
  const data = new Uint8Array(bytes);
  const buf = malloc(data.length);
  M.HEAPU8.set(data, buf);
  const doc = P.FPDF_LoadMemDocument(buf, data.length, '');
  if (!doc) {
    free(buf);
    throw new Error(`PDFを開けませんでした（PDFium のエラー ${P.FPDF_GetLastError()}）`);
  }
  const tmp = malloc(128);
  return {
    P, M, doc, malloc, free, tmp, size: data.length,
    d: (i) => M.getValue(tmp + i * 8, 'double'),
    f: (i) => M.getValue(tmp + i * 4, 'float'),
    u32: (i) => M.getValue(tmp + i * 4, 'i32') >>> 0,
    /** 今の文書を PDF のバイト列にする。 */
    save() {
      const writer = P.PDFiumExt_OpenFileWriter();
      P.PDFiumExt_SaveAsCopy(doc, writer);
      const n = P.PDFiumExt_GetFileWriterSize(writer);
      const out = malloc(n);
      P.PDFiumExt_GetFileWriterData(writer, out, n);
      const result = M.HEAPU8.slice(out, out + n);
      free(out);
      P.PDFiumExt_CloseFileWriter(writer);
      return result;
    },
    close() {
      P.FPDF_CloseDocument(doc);
      free(buf);
      free(tmp);
    },
  };
}
