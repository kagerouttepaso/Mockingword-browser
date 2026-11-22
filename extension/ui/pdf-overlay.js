// 訳している段落に、訳し終えた文と薄くした残りの原文を重ねる。訳文が届くまでは原文を薄く見せる。
// 状態（ui/pdf-state.js）の marks を知らせのたびに描く。PDF のページが差し替わると重ねた表示は消える。
//
// 層はページごとに1つの要素で、作ったら捨てずに使う。座標はページに対する割合なので、拡大縮小しても描き直さない。
// pdf.js はページを描き直すとき（拡大縮小・見えなくなったページの破棄・ページの差し替え）にページの要素の子を消すので、
// ページの要素の子の変化を見て層をページへ置き直す。
import { fitLines } from '../pdf/plan.js';

export function createOverlay(store, viewer) {
  const layers = new Map(); // ページの番号 → { el, observer }
  const context = document.createElement('canvas').getContext('2d');
  const measure = (text, bold, size) => {
    context.font = `${bold ? 700 : 400} 100px sans-serif`;
    return context.measureText(text).width * size / 100;
  };
  const px = (points) => `calc(${points}px * var(--scale-factor))`;

  function layerOf(pi) {
    let layer = layers.get(pi);
    if (layer) return layer.el;
    const div = viewer.getPageView(pi)?.div;
    if (!div) return null;
    const el = document.createElement('div');
    el.className = 'mw-layer';
    el.setAttribute('aria-hidden', 'true');
    const observer = new MutationObserver(() => { if (el.parentNode !== div) div.append(el); });
    observer.observe(div, { childList: true });
    div.append(el);
    layers.set(pi, { el, observer });
    return el;
  }

  function clear() {
    for (const { el, observer } of layers.values()) {
      observer.disconnect();
      el.remove();
    }
    layers.clear();
  }

  function renderText(el, mark, width, height) {
    // 画面のフォントで字幅を測る。PDFに埋め込むフォントの取得を待たずに描く。
    const { size, lead, lines } = fitLines(mark.pieces, width, mark.size, mark.lead, measure,
      ({ lines, size, lead }) => size + (lines.length - 1) * lead <= height
        && lines.every((line) => line.reduce((w, atom) => w + atom.w, 0) <= width));
    const block = document.createElement('div');
    for (const line of lines) {
      const row = document.createElement('div');
      const runs = [];
      for (const { s, pc } of line) {
        const last = runs.at(-1);
        if (last?.pc === pc) last.text += s;
        else runs.push({ text: s, pc });
      }
      for (const { text, pc } of runs) {
        const span = document.createElement('span');
        span.textContent = text;
        if (pc.source) span.className = 'mw-source-tail';
        if (pc.bold) span.style.fontWeight = '700';
        row.append(span);
      }
      block.append(row);
    }
    el.dataset.preview = '';
    el.style.color = `rgb(${mark.color.join(',')})`;
    el.style.fontSize = px(size);
    el.style.lineHeight = px(lead);
    el.style.paddingLeft = px(1);
    el.append(block);
  }

  /** ページ pi の重ね表示を、今の marks に合わせて描く。 */
  function render(pi, state) {
    const marks = [...state.marks.values()].filter((m) => m.page === pi);
    if (!marks.length && !layers.has(pi)) return;
    const layer = layerOf(pi);
    if (!layer) return;
    const [x0, y0, x1, y1] = state.views[pi];
    const W = x1 - x0, H = y1 - y0;
    layer.replaceChildren(...marks.map((m) => {
      const el = document.createElement('div');
      el.className = 'mw-mark';
      const width = m.box.r - m.box.l + 2, height = m.box.t - m.box.b + 2;
      Object.assign(el.style, {
        left: `${((m.box.l - 1 - x0) / W) * 100}%`, top: `${((y1 - m.box.t - 1) / H) * 100}%`,
        width: `${(width / W) * 100}%`, height: `${(height / H) * 100}%`,
        background: `rgb(${m.background.join(',')})`,
      });
      if (m.pieces.length) renderText(el, m, width - 1, height);
      return el;
    }));
  }

  store.subscribe((change, state) => {
    if (change.type === 'document' || change.type === 'reset') clear();
    else if (change.type === 'marks' || change.type === 'version') for (const pi of change.pages) render(pi, state);
  });
}
