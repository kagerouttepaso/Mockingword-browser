// 訳文の段落をどこにどう置くか（大きさ・行送り・行ごとの並び）を決める。訳したPDFへの書き込み（pdf/write.js）が使う。
// 座標は PDF のページの点（左下が原点）。DOM にも PDFium にも触れない。
import { layout } from './layout.js';

const MIN_SCALE = 0.7;
const STEP = 0.05;

/** 段落の訳す文字の外接の四角（原文を覆う範囲）。 */
export function paragraphBox(p) {
  const cs = p.chars.filter((c) => c.tr);
  return { l: Math.min(...cs.map((c) => c.l)), r: Math.max(...cs.map((c) => c.r)), b: Math.min(...cs.map((c) => c.b)), t: Math.max(...cs.map((c) => c.t)) };
}

/**
 * 段落 p（p.pieces が訳文の書式つきの断片）の置き方を決める。all は同じページの全段落、measure(s, bold, size) は字幅。
 * 下の段落に重ならない行数に収まるまで、文字と行送りを 0.05 倍ずつ 0.7 倍まで縮める。
 * 返す値：{ masked（フォームの中の文字で、消せないので覆う）, box, size, lead, shrunk, lines: [{ base, runs: [{ s, w, x, bold, link }] }] }。
 */
export function planParagraph(p, all, measure) {
  const masked = p.objs.some((o) => o.includes('/'));
  const box = paragraphBox(p);
  const below = all.filter((q) => q !== p && q.y < p.bottom - 1 && q.x0 < p.right && q.right > p.x0).sort((a, b) => b.y - a.y)[0];
  const floor = below ? Math.min(p.bottom, below.y + below.size * 1.15) : p.bottom;
  const width = (masked ? (box.r - p.x0) * (p.lines > 1 ? 1 : 1.15) : p.right - p.x0) + 0.5;
  let chosen = null;
  for (let k = 0; 1 - k * STEP >= MIN_SCALE - 1e-9; k++) {
    const scale = 1 - k * STEP;
    const lines = layout(p.pieces, width, p.size * scale, measure);
    chosen = { size: p.size * scale, lead: p.lead * scale, lines, k };
    if (p.y - (lines.length - 1) * chosen.lead >= floor - 0.5) break;
  }
  return {
    masked, box, size: chosen.size, lead: chosen.lead, shrunk: chosen.k > 0,
    lines: chosen.lines.map((line, li) => {
      // 書式の同じ並びを1つにまとめる（PDF では1つのテキストのオブジェクト、画面では1つの要素）
      const runs = [];
      let x = p.x0;
      for (const a of line) {
        const last = runs.at(-1);
        if (last && last.bold === a.pc.bold && last.link === a.pc.link) { last.s += a.s; last.w += a.w; }
        else runs.push({ s: a.s, w: a.w, x, bold: a.pc.bold, link: a.pc.link });
        x += a.w;
      }
      return { base: p.y - li * chosen.lead, runs };
    }),
  };
}
