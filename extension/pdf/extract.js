// PDF の文字を1文字ずつ読み、セグメント（同じ基線の文字の並び）→段落に組み、
// 段落の中のリンク・太字・等幅をマーカー（shared/markup.js）にした1行を作る。
// 流れと判定の理由は docs/12_PDFの翻訳.md「段落の組み立て」。
import { encode } from '../shared/markup.js';

const BOLD = /bold|black|heavy/i;
const MONO = /mono|courier|typewriter|cmtt|consol/i;
const isBold = (c) => c.weight >= 600 || BOLD.test(c.font);
/** 箇条書きの印（訳さずに残す）。 */
const BULLET = /^([•–·◦▪])\s*/;
/** 目次の点線（". . . ."）。見出しと分ける。 */
const LEADER = /^(.*?\S)\s*((?:\.\s){3,}\.?\s*)$/;
const LINK_SUBTYPE = 2; // FPDF_ANNOT_LINK
const TEXT_OBJECT = 1; // FPDF_PAGEOBJ_TEXT
const FORM_OBJECT = 5; // FPDF_PAGEOBJ_FORM

/**
 * 文書の全ページの段落を返す。段落：
 *   page・text（マーカー付きの1行）・plain・kinds・elems（要素の番号順：kind 'a'|'c'、link＝注釈の番号、bold、code）・whole（段落全体が1つのリンク）
 *   x0・right・y（1行目の基線）・bottom（最後の行の基線）・lines・lead・size・bold・color
 *   objs（訳す文字を含むテキストのオブジェクトの道筋）・chars（段落の全文字。tr＝訳す文字か）・skip（訳さない理由）
 */
export function extractParagraphs(X) {
  const { P, doc } = X;
  const out = [];
  for (let pi = 0, n = P.FPDF_GetPageCount(doc); pi < n; pi++) {
    const page = P.FPDF_LoadPage(doc, pi);
    const tp = P.FPDFText_LoadPage(page);
    try {
      out.push(...pageParagraphs(X, pi, page, tp));
    } finally {
      P.FPDFText_ClosePage(tp);
      P.FPDF_ClosePage(page);
    }
  }
  // 3ページ以上で同じ位置に同じ文字列（数字は問わない）がある段落はヘッダー・フッターとして訳さない。
  // 訳す文字の無い段落（番号・点線）と、もう日本語の段落も訳さない。
  const keyOf = (p) => `${Math.round(p.y)}|${p.plain.replace(/\d+/g, '#')}`;
  const repeats = new Map();
  for (const p of out) repeats.set(keyOf(p), (repeats.get(keyOf(p)) ?? 0) + 1);
  for (const p of out) {
    p.skip = repeats.get(keyOf(p)) >= 3 ? 'repeat'
      : !/\p{L}{2,}/u.test(p.plain) ? 'no-words'
      : /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(p.plain) ? 'japanese'
      : null;
  }
  return out;
}

/** テキストのオブジェクト → ページからの道筋（"5/0/12"：ページの5番目のフォームの0番目のフォームの12番目）。 */
function textObjects(X, page) {
  const { P } = X;
  const map = new Map();
  const walk = (count, get, prefix) => {
    for (let i = 0, n = count(); i < n; i++) {
      const o = get(i);
      const path = prefix ? `${prefix}/${i}` : String(i);
      const type = P.FPDFPageObj_GetType(o);
      if (type === TEXT_OBJECT) map.set(o, path);
      else if (type === FORM_OBJECT) walk(() => P.FPDFFormObj_CountObjects(o), (j) => P.FPDFFormObj_GetObject(o, j), path);
    }
  };
  walk(() => P.FPDFPage_CountObjects(page), (i) => P.FPDFPage_GetObject(page, i), '');
  return map;
}

function fontName(X, tp, i) {
  const { P, M } = X;
  const n = P.FPDFText_GetFontInfo(tp, i, 0, 0, 0);
  if (n <= 0) return '';
  const p = X.malloc(n + 1);
  P.FPDFText_GetFontInfo(tp, i, p, n, 0);
  const s = M.UTF8ToString(p);
  X.free(p);
  return s;
}

/** ページの文字を読む。生成された空白以外の生成文字（改行）は捨てる。 */
function readChars(X, page, tp) {
  const { P, tmp, d, f } = X;
  const links = [];
  for (let i = 0, n = P.FPDFPage_GetAnnotCount(page); i < n; i++) {
    const a = P.FPDFPage_GetAnnot(page, i);
    if (P.FPDFAnnot_GetSubtype(a) === LINK_SUBTYPE) {
      P.FPDFAnnot_GetRect(a, tmp);
      links.push({ index: i, l: f(0), t: f(1), r: f(2), b: f(3) });
    }
    P.FPDFPage_CloseAnnot(a);
  }
  const objects = textObjects(X, page);
  // フォント・太さ・色・大きさはテキストのオブジェクトごとに同じなので、オブジェクトごとに1回だけ読む（文字ごとに PDFium を呼ぶ
  // 回数が読み取りの時間の大半を占める。300ページで約4秒）
  const styles = new Map();
  const styleOf = (handle, i) => {
    let st = styles.get(handle);
    if (st) return st;
    P.FPDFText_GetFillColor(tp, i, tmp, tmp + 4, tmp + 8, tmp + 12);
    const color = [X.u32(0), X.u32(1), X.u32(2)];
    // 文字の大きさは、フォントの大きさ（Tf）に文字の実際の変換（テキストの行列・CTM・埋め込みのフォームの行列を掛けたもの）の
    // 縦の拡大率を掛けた値。Tf だけでは、縮めて描く PDF（Web ページから作った予約確認など。行列が 0.6 倍）で訳文が大きくなる。
    P.FPDFText_GetMatrix(tp, i, tmp);
    const size = P.FPDFText_GetFontSize(tp, i) * Math.hypot(f(2), f(3));
    st = { color, size, weight: P.FPDFText_GetFontWeight(tp, i), font: fontName(X, tp, i), obj: objects.get(handle) ?? null };
    styles.set(handle, st);
    return st;
  };
  const chars = [];
  for (let i = 0, n = P.FPDFText_CountChars(tp); i < n; i++) {
    const u = P.FPDFText_GetUnicode(tp, i);
    const gen = P.FPDFText_IsGenerated(tp, i) === 1;
    if ((gen && u !== 32) || u === 13 || u === 10 || u === 0) continue;
    P.FPDFText_GetCharBox(tp, i, tmp, tmp + 8, tmp + 16, tmp + 24);
    const [l, r, b, t] = [d(0), d(1), d(2), d(3)];
    P.FPDFText_GetCharOrigin(tp, i, tmp, tmp + 8);
    const [ox, oy] = [d(0), d(1)];
    // 生成された空白は前の文字の書式を使う（オブジェクトに属さない）
    const st = gen ? { ...(chars.at(-1) ?? { color: [0, 0, 0], size: 0 }), weight: 0, font: '', obj: null } : styleOf(P.FPDFText_GetTextObject(tp, i), i);
    const cx = (l + r) / 2, cy = (b + t) / 2;
    const link = gen ? null : links.find((k) => cx >= k.l - 0.5 && cx <= k.r + 0.5 && cy >= k.b - 0.5 && cy <= k.t + 0.5)?.index ?? null;
    chars.push({
      ch: String.fromCodePoint(u), gen, l, r, b, t, ox, oy, color: st.color, link,
      size: st.size,
      weight: st.weight,
      font: st.font,
      obj: st.obj,
      hyphen: P.FPDFText_IsHyphen(tp, i) === 1,
    });
  }
  return chars;
}

/** 同じ基線で、大きな間の空かない文字の並び（セグメント）に分ける。上付き文字は同じセグメントに含める。 */
function segments(chars) {
  const segs = [];
  let cur = null;
  for (const c of chars) {
    if (c.ch === ' ') { if (cur) cur.chars.push(c); continue; }
    const last = cur?.chars.findLast((x) => x.ch !== ' ');
    const sup = cur && c.size < 0.8 * cur.size && Math.abs(c.oy - cur.y) < 0.6 * cur.size && c.l > last.r - cur.size && c.l < last.r + cur.size;
    const fresh = !sup && (!cur || Math.abs(c.oy - cur.y) > 0.4 * c.size || c.l < last.r - c.size || c.l - last.r > Math.max(c.size, cur.size));
    if (fresh) { cur = { chars: [], y: c.oy, size: c.size }; segs.push(cur); }
    cur.chars.push(c);
    if (!sup) cur.size = Math.max(cur.size, c.size);
  }
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const m = s.chars.map((c) => c.ch).join('').match(LEADER);
    if (m && /\p{L}/u.test(m[1])) {
      segs.splice(k + 1, 0, { ...s, chars: s.chars.slice(m[1].length) });
      s.chars = s.chars.slice(0, m[1].length);
    }
  }
  for (const s of segs) {
    while (s.chars.at(-1)?.ch === ' ') s.chars.pop();
    while (s.chars[0]?.ch === ' ') s.chars.shift();
    const real = s.chars.filter((c) => c.ch !== ' ');
    s.x0 = Math.min(...real.map((c) => c.l));
    s.x1 = Math.max(...real.map((c) => c.r));
    s.bold = real.filter(isBold).length > real.length / 2;
    const m = s.chars.map((c) => c.ch).join('').match(BULLET);
    s.bullet = m ? m[0].length : 0;
    s.textX0 = s.bullet ? s.chars.slice(s.bullet).find((c) => c.ch !== ' ')?.l ?? s.x0 : s.x0;
  }
  return segs.filter((s) => s.chars.length);
}

/** 段落の文字 → トークン列（リンク・太字の違い＝要素、等幅＝写す要素）。 */
function tokensOf(chs, baseBold) {
  const tokens = [];
  const elems = [];
  let state = null;
  const styleOf = (c) => {
    if (c.gen || c.ch === ' ') return undefined; // 空白は今の状態を続ける
    if (MONO.test(c.font)) return `c:${c.link}:false`;
    const bold = isBold(c) !== baseBold;
    if (c.link !== null || bold) return `a:${c.link}:${bold}`;
    return null;
  };
  const close = () => {
    if (!state) return;
    const e = elems[state.id - 1];
    if (e.kind === 'c') tokens.push({ type: 'code', id: e.id, text: e.code.trim() });
    else tokens.push({ type: 'close', id: e.id });
    state = null;
  };
  for (const c of chs) {
    const key = styleOf(c) === undefined ? state?.key ?? null : styleOf(c);
    if (key !== (state?.key ?? null)) {
      close();
      if (key) {
        const [kind, link, bold] = key.split(':');
        const e = { id: elems.length + 1, kind, link: link === 'null' ? null : Number(link), bold: bold === 'true', code: '' };
        elems.push(e);
        state = { key, id: e.id };
        if (kind === 'a') tokens.push({ type: 'open', id: e.id });
      }
    }
    if (state && elems[state.id - 1].kind === 'c') elems[state.id - 1].code += c.ch;
    else if (tokens.at(-1)?.type === 'text') tokens.at(-1).text += c.ch;
    else tokens.push({ type: 'text', text: c.ch });
  }
  close();
  for (const e of elems) e.code = e.code.trim();
  return { tokens, elems };
}

function pageParagraphs(X, pi, page, tp) {
  const segs = segments(readChars(X, page, tp));
  const pageRight = Math.max(0, ...segs.map((s) => s.x1));
  segs.sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const sameLine = (s) => segs.filter((o) => o !== s && Math.abs(o.y - s.y) < 0.4 * s.size);
  // 左端がそろい、行送りの間隔で続き、大きさと太さが同じセグメントを段落にする。表の行（同じ行に別のセグメントがある行）からはつなげない。
  const groups = [];
  for (const s of segs) {
    const prev = groups.at(-1);
    const last = prev?.segs.at(-1);
    const gap = last ? last.y - s.y : 0;
    const joinable = prev && !s.bullet && sameLine(s).length === 0
      && Math.abs(s.size - last.size) < 0.6 && s.bold === last.bold && gap > 0.8 * s.size && gap < 1.7 * s.size
      && Math.abs(s.x0 - prev.textX0) < 3;
    if (joinable) prev.segs.push(s);
    else groups.push({ segs: [s], textX0: s.textX0, bullet: s.bullet });
  }
  return groups.map((g) => {
    const first = g.segs[0];
    // 訳す文字：箇条書きの印を除き、行末のハイフンを取って行をつなぐ
    const chs = [];
    g.segs.forEach((s, si) => {
      const cs = s.chars.slice(si === 0 ? g.bullet : 0);
      cs.forEach((c, ci) => { if (!(c.hyphen && ci === cs.length - 1)) chs.push(c); });
      if (si < g.segs.length - 1 && !cs.at(-1)?.hyphen) chs.push({ ch: ' ', gen: true });
    });
    const translated = new Set(chs.filter((c) => !c.gen && c.ch !== ' '));
    const { tokens, elems } = tokensOf(chs, first.bold);
    let { text, plain } = encode(tokens);
    // 段落の全体が1つのリンク・飾りなら、マーカーを外して段落の属性にする（モデルにマーカーを落とさせない）
    let whole = null;
    if (elems.length === 1 && elems[0].kind === 'a' && text === `<a1>${plain}</a1>`) {
      whole = elems.pop();
      text = plain;
    }
    const lines = g.segs.length;
    const others = sameLine(first).filter((o) => o.x0 > first.x1).map((o) => o.x0);
    const right = lines > 1 ? Math.max(...g.segs.map((s) => s.x1)) : others.length ? Math.min(...others) - 4 : pageRight;
    const all = g.segs.flatMap((s) => s.chars).filter((c) => !c.gen && c.ch !== ' ');
    return {
      page: pi, text, plain, kinds: elems.map((e) => e.kind), elems, whole,
      x0: g.textX0, right: Math.max(right, first.x1), y: first.y, bottom: g.segs.at(-1).y, lines,
      lead: lines > 1 ? (first.y - g.segs.at(-1).y) / (lines - 1) : first.size * 1.25,
      size: first.size, bold: first.bold, color: [...translated][0]?.color ?? [0, 0, 0],
      objs: [...new Set([...translated].map((c) => c.obj).filter((o) => o !== null))],
      chars: all.map((c) => ({ ch: c.ch, ox: c.ox, oy: c.oy, l: c.l, r: c.r, b: c.b, t: c.t, obj: c.obj, tr: translated.has(c) })),
    };
  });
}
