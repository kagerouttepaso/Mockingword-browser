// 訳文を PDF へ書く。原文のテキストのオブジェクトを消し（消せないフォームの中の文字は背景色 p.background で覆い）、訳文を組んで書き、
// リンクの範囲を訳文の位置へ移す。画面に出す訳したPDFと保存するPDFは、この書き方で書いた1つの文書。判定の理由は docs/12_PDFの翻訳.md「書き込み」。
import { decode } from '../shared/markup.js';
import { paragraphBox, paragraphGeometry, planParagraph } from './plan.js';

const FPDF_FONT_TRUETYPE = 2;
const FPDF_FILLMODE_ALTERNATE = 1;

const plainOf = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/** マーカーを復号した木 → 書式つきの断片 [{ text, bold, link }]。写す要素（等幅の文字）は原文の文字を使う。 */
export function piecesOf(p, nodes) {
  const pieces = [];
  const walk = (nodes, st) => {
    for (const n of nodes) {
      if (n.type === 'text') pieces.push({ text: n.text, ...st });
      else if (n.type === 'code') pieces.push({ text: p.elems[n.id - 1].code, ...st });
      else if (n.type === 'wrap') {
        const e = p.elems[n.id - 1];
        walk(n.children, { bold: e.bold ? !st.bold : st.bold, link: e.link ?? st.link });
      }
    }
  };
  walk(nodes, { bold: p.bold, link: p.whole?.link ?? null });
  return pieces;
}

/**
 * 訳文の付いた段落を書ける形にする（訳文 → 書式つきの断片 p.pieces）。訳文が原文と同じ段落（型番・住所・規格番号など）は
 * 原文を残す（p.skip = 'same'）。何度呼んでもよい（訳し終えるたびに呼ぶ）。返す値：書く段落。
 */
export function prepare(paras, translations) {
  const todo = [];
  for (const p of paras) {
    if ((p.skip && p.skip !== 'same') || !translations.has(p.text)) continue;
    if (plainOf(translations.get(p.text)) === plainOf(p.plain)) { p.skip = 'same'; continue; }
    p.pieces ??= piecesOf(p, decode(translations.get(p.text), p.kinds));
    todo.push(p);
  }
  return todo;
}

/**
 * 日本語フォントを文書へ丸ごと読み込む（1つの文書に1回）。訳したページを足していっても、フォントは全部のページで共有するので
 * 増えない（ページを書くたびにフォントを読み込むと、使われなくなったフォントも PDFium が保存し続ける）。保存するときに
 * 使っていない字形を抜く（pdf/finish.js）。返す値：{ regular, bold }（PDFium のフォントのハンドル）。
 */
export function embedFonts(X, fonts) {
  const { P, M, doc } = X;
  const handles = {};
  for (const key of ['regular', 'bold']) {
    const bytes = new Uint8Array(fonts[key].bytes);
    const ptr = X.malloc(bytes.length);
    M.HEAPU8.set(bytes, ptr);
    handles[key] = P.FPDFText_LoadFont(doc, ptr, bytes.length, FPDF_FONT_TRUETYPE, true); // ptr は文書を閉じるまで解放しない
  }
  return handles;
}

export const newStats = () => ({ translated: 0, same: 0, masked: 0, shrunk: 0, links: 0, kept: 0 });

/**
 * ページ pi に、訳し終えた段落 mine（prepare の値のうちそのページの分）を書く。ページは1回だけ書く（原文のテキストの
 * オブジェクトの道筋は、書く前のページで数えたもの）。all はそのページの全段落、handles は embedFonts の値。
 */
export function writePageAt(X, pi, all, mine, handles, measure, stats) {
  const { P } = X;
  const page = P.FPDF_LoadPage(X.doc, pi);
  try {
    writePage(X, page, all, mine, handles, measure, stats);
    P.FPDFPage_GenerateContent(page);
  } finally {
    P.FPDF_ClosePage(page);
  }
}

function writePage(X, page, all, mine, handles, measure, stats) {
  const { P, M, doc, tmp, f } = X;
  // 置き方は原文を消す前に決める（下の段落の位置を使う）。フォームの中の文字は、消してもフォームの中身が書き直されない
  // （PDFium の制約）。その段落は背景色（p.background。pdf/background.js）で覆って上に書く。
  const plans = mine.map((p) => {
    const geometry = p.geometry ?? paragraphGeometry(p, all);
    return { p, geometry, plan: planParagraph(geometry, p.pieces, measure) };
  });

  // 道筋（"5/0/12"）からハンドルと親（フォームの中なら親のフォーム）を引く
  const resolve = (path) => {
    const idx = path.split('/').map(Number);
    let parent = null, h = P.FPDFPage_GetObject(page, idx[0]);
    for (const i of idx.slice(1)) { parent = h; h = P.FPDFFormObj_GetObject(h, i); }
    return { h, parent };
  };
  const removable = [...new Set(mine.flatMap((p) => p.objs).filter((o) => !o.includes('/')))];
  const handleOf = new Map(removable.map((path) => [path, resolve(path)]));
  const removeSet = new Set(removable);
  // 消すオブジェクトにある訳さない文字（番号・点線・箇条書きの印など）は、元のフォント・大きさ・変換行列で1文字ずつ置き直す
  const translating = new Set(mine);
  for (const p of all) {
    for (const c of p.chars) {
      if (!removeSet.has(c.obj) || (translating.has(p) && c.tr)) continue;
      const { h } = handleOf.get(c.obj);
      P.FPDFTextObj_GetFontSize(h, tmp);
      const size = f(0);
      P.FPDFPageObj_GetMatrix(h, tmp);
      const m = [0, 1, 2, 3].map((k) => f(k));
      P.FPDFPageObj_GetFillColor(h, tmp, tmp + 4, tmp + 8, tmp + 12);
      const color = [0, 1, 2, 3].map(X.u32);
      const o = P.FPDFPageObj_CreateTextObj(doc, P.FPDFTextObj_GetFont(h), size);
      setText(X, o, c.ch);
      [...m, c.ox, c.oy].forEach((v, k) => M.setValue(tmp + 32 + k * 4, v, 'float'));
      P.FPDFPageObj_SetMatrix(o, tmp + 32);
      P.FPDFPageObj_SetFillColor(o, ...color);
      P.FPDFPage_InsertObject(page, o);
      stats.kept++;
    }
  }
  for (const h of [...[...handleOf.values()].map(({ h }) => h), ...textDecorations(X, page, mine)]) {
    P.FPDFPage_RemoveObject(page, h);
    P.FPDFPageObj_Destroy(h);
  }

  const linkRects = new Map();
  for (const { p, geometry, plan } of plans) {
    if (geometry.masked) {
      const [r, g, b] = p.background;
      const { box } = geometry;
      const rect = P.FPDFPageObj_CreateNewRect(box.l - 1, box.b - 1, box.r - box.l + 2, box.t - box.b + 2);
      P.FPDFPageObj_SetFillColor(rect, r, g, b, 255);
      P.FPDFPath_SetDrawMode(rect, FPDF_FILLMODE_ALTERNATE, false);
      P.FPDFPage_InsertObject(page, rect);
      stats.masked++;
    }
    if (plan.shrunk) stats.shrunk++;
    const [r, g, b] = p.color;
    for (const line of plan.lines) {
      for (const run of line.runs) {
        const o = P.FPDFPageObj_CreateTextObj(doc, handles[run.bold ? 'bold' : 'regular'], plan.size);
        setText(X, o, run.s);
        P.FPDFPageObj_SetFillColor(o, r, g, b, 255);
        P.FPDFPageObj_Transform(o, 1, 0, 0, 1, run.x, line.base);
        P.FPDFPage_InsertObject(page, o);
        if (run.link !== null) {
          if (!linkRects.has(run.link)) linkRects.set(run.link, []);
          linkRects.get(run.link).push([run.x, line.base - 0.25 * plan.size, run.x + run.w, line.base + 0.95 * plan.size]);
        }
      }
    }
    stats.translated++;
  }
  moveLinks(X, page, mine, linkRects, stats);
}

const PATH_OBJECT = 2; // FPDF_PAGEOBJ_PATH

/**
 * 訳す段落の文字の飾り（インラインコードの背景・蛍光ペンなど、文字の行の上に塗った図形）。原文の文字と一緒に消す。
 * 残すと、訳文は別の位置に組むので、飾りだけが原文の位置に残り、訳文の行の途中や行末に灰色の帯が見えた（2026-11-25、作者の報告）。
 * 飾りと見なすのは、ページの直下の塗りのある図形で、高さが文字の大きさの1.5倍以下、縦の中心が訳す文字の行の中、横の中心がその行の
 * 訳す文字の範囲の中にあるもの。表の罫線（細い四角で描くPDFもある）は行の外か文字の範囲の外に、セルの塗りは行より高いので残る。
 * 埋め込みのフォームの中の図形は消せない（PDFium の制約。その段落は背景色で覆う）。
 */
function textDecorations(X, page, paras) {
  const { P, tmp, f } = X;
  const lines = [];
  for (const p of paras) {
    for (const c of p.chars) {
      if (!c.tr) continue;
      const line = lines.find((l) => Math.abs(l.oy - c.oy) < 0.3 * p.size);
      if (line) Object.assign(line, { l: Math.min(line.l, c.l), r: Math.max(line.r, c.r), b: Math.min(line.b, c.b), t: Math.max(line.t, c.t) });
      else lines.push({ oy: c.oy, size: p.size, l: c.l, r: c.r, b: c.b, t: c.t });
    }
  }
  const found = [];
  for (let i = 0, n = P.FPDFPage_CountObjects(page); i < n; i++) {
    const o = P.FPDFPage_GetObject(page, i);
    if (P.FPDFPageObj_GetType(o) !== PATH_OBJECT) continue;
    P.FPDFPath_GetDrawMode(o, tmp, tmp + 4);
    if (!X.u32(0)) continue; // 塗りの無い線（罫線・枠）は飾りにしない
    P.FPDFPageObj_GetBounds(o, tmp, tmp + 4, tmp + 8, tmp + 12);
    const [l, b, r, t] = [f(0), f(1), f(2), f(3)];
    const cx = (l + r) / 2, cy = (b + t) / 2;
    if (lines.some((line) => t - b <= 1.5 * line.size && cy >= line.b && cy <= line.t && cx >= line.l && cx <= line.r)) found.push(o);
  }
  return found;
}

const FPDF_ANNOT_LINK = 2;
const PDFACTION_GOTO = 1;
const PDFACTION_URI = 3;

/** ページのリンクの注釈の番号 → { key（飛び先。同じ飛び先なら同じ値）, rect: { l, b, r, t } }。 */
function pageLinks(X, page) {
  const { P, M, doc, tmp, f } = X;
  const destKey = (dest) => {
    P.FPDFDest_GetLocationInPage(dest, tmp, tmp + 4, tmp + 8, tmp + 12, tmp + 16, tmp + 20);
    return `dest:${P.FPDFDest_GetDestPageIndex(doc, dest)}:${X.u32(0) ? f(3).toFixed(1) : '-'}:${X.u32(1) ? f(4).toFixed(1) : '-'}`;
  };
  const links = new Map();
  for (let i = 0, n = P.FPDFPage_GetAnnotCount(page); i < n; i++) {
    const a = P.FPDFPage_GetAnnot(page, i);
    try {
      if (P.FPDFAnnot_GetSubtype(a) !== FPDF_ANNOT_LINK) continue;
      P.FPDFAnnot_GetRect(a, tmp);
      const rect = { l: f(0), t: f(1), r: f(2), b: f(3) };
      const link = P.FPDFAnnot_GetLink(a);
      let key = `annot:${i}`;
      const dest = link && P.FPDFLink_GetDest(doc, link);
      const action = link && P.FPDFLink_GetAction(link);
      if (dest) key = destKey(dest);
      else if (action && P.FPDFAction_GetType(action) === PDFACTION_URI) {
        const len = P.FPDFAction_GetURIPath(doc, action, 0, 0);
        const buf = X.malloc(len);
        P.FPDFAction_GetURIPath(doc, action, buf, len);
        key = `uri:${M.UTF8ToString(buf)}`;
        X.free(buf);
      } else if (action && P.FPDFAction_GetType(action) === PDFACTION_GOTO) {
        const d = P.FPDFAction_GetDest(doc, action);
        if (d) key = destKey(d);
      }
      links.set(i, { key, rect });
    } finally {
      P.FPDFPage_CloseAnnot(a);
    }
  }
  return links;
}

/**
 * 訳した段落のリンクを訳文の位置へ移す。原文では1つのリンクが行ごと・入れ子の複数の注釈になっていることがある（LaTeX の hyperref
 * など。Kvaser の取説の「Section 3.6 … (page 10)」は2行・4つの注釈）。訳した段落の中にある注釈を飛び先ごとにまとめ、
 * 1つ目を訳文の位置へ移して残りは消す（残すと原文の位置に古い範囲が残る）。訳文が複数行にまたがるときは、範囲（Rect）を
 * 行の外接にし、行ごとの範囲を QuadPoints に入れる（pdf.js などは QuadPoints の行ごとにリンクを置く）。
 * linkRects は注釈の番号 → 訳文の行ごとの四角 [l, b, r, t] の配列。
 */
function moveLinks(X, page, mine, linkRects, stats) {
  const { P, M, tmp } = X;
  if (!linkRects.size) return;
  const links = pageLinks(X, page);
  // 飛び先 → 訳文の四角（同じ行の四角は1つにまとめる）
  const rectsOf = new Map();
  for (const [index, rects] of linkRects) {
    const key = links.get(index)?.key ?? `annot:${index}`;
    const list = rectsOf.get(key) ?? [];
    for (const q of rects) {
      const same = list.find((o) => Math.abs(o[1] - q[1]) < 0.5 && Math.abs(o[3] - q[3]) < 0.5);
      if (same) { same[0] = Math.min(same[0], q[0]); same[2] = Math.max(same[2], q[2]); }
      else list.push([...q]);
    }
    rectsOf.set(key, list);
  }
  // 訳した段落の中にある注釈（中心が段落の四角の中）。文字から見つけた注釈も含める
  const boxes = mine.map((p) => paragraphBox(p));
  const inside = new Map();
  for (const [index, { key, rect }] of links) {
    const cx = (rect.l + rect.r) / 2, cy = (rect.b + rect.t) / 2;
    const within = linkRects.has(index) || boxes.some((b) => cx >= b.l - 1 && cx <= b.r + 1 && cy >= b.b - 1 && cy <= b.t + 1);
    if (!within || !rectsOf.has(key)) continue;
    if (!inside.has(key)) inside.set(key, []);
    inside.get(key).push(index);
  }
  const removed = [];
  for (const [key, indices] of inside) {
    const rects = rectsOf.get(key);
    const [first, ...rest] = indices.sort((a, b) => a - b);
    const a = P.FPDFPage_GetAnnot(page, first);
    const l = Math.min(...rects.map((q) => q[0])), b = Math.min(...rects.map((q) => q[1]));
    const r = Math.max(...rects.map((q) => q[2])), t = Math.max(...rects.map((q) => q[3]));
    [l, t, r, b].forEach((v, k) => M.setValue(tmp + k * 4, v, 'float'));
    P.FPDFAnnot_SetRect(a, tmp);
    if (rects.length > 1) {
      // QuadPoints の点の順は左上・右上・左下・右下（Acrobat・pdf.js と同じ）
      const n = P.FPDFAnnot_CountAttachmentPoints(a);
      rects.forEach(([ql, qb, qr, qt], k) => {
        [ql, qt, qr, qt, ql, qb, qr, qb].forEach((v, j) => M.setValue(tmp + j * 4, v, 'float'));
        if (k < n) P.FPDFAnnot_SetAttachmentPoints(a, k, tmp);
        else P.FPDFAnnot_AppendAttachmentPoints(a, tmp);
      });
    }
    P.FPDFPage_CloseAnnot(a);
    removed.push(...rest);
    stats.links++;
  }
  // 番号がずれないよう、後ろの注釈から消す
  for (const index of removed.sort((a, b) => b - a)) P.FPDFPage_RemoveAnnot(page, index);
}

function setText(X, obj, text) {
  const n = (text.length + 1) * 2;
  const p = X.malloc(n);
  X.M.stringToUTF16(text, p, n);
  X.P.FPDFText_SetText(obj, p);
  X.free(p);
}
