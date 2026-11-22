// 訳文の段落をどこにどう置くか（大きさ・行送り・行ごとの並び）を決める。途中表示とPDFへの書き込みが使う。
// 座標は PDF のページの点（左下が原点）。DOM にも PDFium にも触れない。
import { layout } from './layout.js';

const MIN_SCALE = 0.7;
const STEP = 0.05;

/** 段落の訳す文字の外接の四角（原文を覆う範囲）。 */
export function paragraphBox(p) {
  const cs = p.chars.filter((c) => c.tr);
  return { l: Math.min(...cs.map((c) => c.l)), r: Math.max(...cs.map((c) => c.r)), b: Math.min(...cs.map((c) => c.b)), t: Math.max(...cs.map((c) => c.t)) };
}

/** 文字と行送りを同じ割合で縮め、表示先の条件に収まる行分けを選ぶ。 */
function fitLines(pieces, width, size, lead, measure, fits) {
  let chosen;
  for (let k = 0; 1 - k * STEP >= MIN_SCALE - 1e-9; k++) {
    const scale = 1 - k * STEP;
    chosen = { size: size * scale, lead: lead * scale, lines: layout(pieces, width, size * scale, measure), shrunk: k > 0 };
    if (fits(chosen)) break;
  }
  return chosen;
}

/** 元の段落と同じページの全段落から、訳文を置ける範囲を決める。 */
export function paragraphGeometry(p, all) {
  const masked = p.objs.some((o) => o.includes('/'));
  const box = paragraphBox(p);
  const below = all.filter((q) => q !== p && q.y < p.bottom - 1 && q.x0 < p.right && q.right > p.x0).sort((a, b) => b.y - a.y)[0];
  const floor = below ? Math.min(p.bottom, below.y + below.size * 1.15) : p.bottom;
  const width = (masked ? (box.r - p.x0) * (p.lines > 1 ? 1 : 1.15) : p.right - p.x0) + 0.5;
  return { masked, box, x: p.x0, y: p.y, width, floor: floor - 0.5, size: p.size, lead: p.lead };
}

/** 訳文を折り返し、下の段落に重なる場合は文字と行送りを縮める。残りの原文は訳文の大きさを変えず、空きに続ける。 */
export function planParagraph({ x, y, width, floor, size, lead }, pieces, measure) {
  const translation = pieces.filter((piece) => !piece.source);
  const chosen = fitLines(translation, width, size, lead, measure,
    ({ lines, lead }) => y - (lines.length - 1) * lead >= floor);
  const lines = translation.length === pieces.length ? chosen.lines : layout(pieces, width, chosen.size, measure);
  return {
    size: chosen.size, lead: chosen.lead, shrunk: chosen.shrunk,
    lines: lines.map((line, li) => {
      // 書式の同じ並びを1つにまとめる（PDF では1つのテキストのオブジェクト、画面では1つの要素）
      const runs = [];
      const base = y - li * chosen.lead;
      let left = x;
      for (const a of line) {
        const { bold, link, source } = a.pc;
        if (source && (base < floor || left + a.w > x + width)) break;
        const last = runs.at(-1);
        if (last && last.bold === bold && last.link === link && last.source === source) { last.s += a.s; last.w += a.w; }
        else runs.push({ s: a.s, w: a.w, x: left, bold, link, source });
        left += a.w;
      }
      return { base, runs };
    }).filter((line) => line.runs.length),
  };
}
