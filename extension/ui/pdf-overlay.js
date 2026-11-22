// 訳している段落に、訳し終えた文と薄くした残りの原文を重ねる。訳文が届くまでは原文を薄く見せる。
// 状態（ui/pdf-state.js）の marks を知らせのたびに描く。PDF のページが差し替わると重ねた表示は消える。
//
// 層はページごとに1つの要素で、作ったら捨てずに使う。座標はページに対する割合なので、拡大縮小しても描き直さない。
// pdf.js はページを描き直すとき（拡大縮小・見えなくなったページの破棄・ページの差し替え）にページの要素の子を消すので、
// ページの要素の子の変化を見て層をページへ置き直す。
import { loadFonts, measureWithFonts, PDF_FONT_FAMILY } from '../pdf/fonts.js';
import { planParagraph } from '../pdf/plan.js';

function svg(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

export function createOverlay(store, viewer) {
  const layers = new Map(); // ページの番号 → { el, observer }
  const context = document.createElement('canvas').getContext('2d');
  let measure = (text, bold, size) => {
    context.font = `${bold ? 700 : 400} 100px sans-serif`;
    return context.measureText(text).width * size / 100;
  };
  let family = 'sans-serif';
  let fontLoad;

  function layerOf(pi) {
    let layer = layers.get(pi);
    if (layer) return layer.el;
    const div = viewer.getPageView(pi)?.div;
    if (!div) return null;
    const el = svg('svg', { class: 'mw-layer', 'aria-hidden': 'true', preserveAspectRatio: 'none' });
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

  function renderText(mark, x0, y1) {
    const { size, lines } = planParagraph(mark.geometry, mark.pieces, measure);
    const text = svg('g', { class: 'mw-mark', 'data-preview': '', 'data-mark-id': mark.id,
      fill: `rgb(${mark.color.join(',')})`, 'font-family': family, 'font-size': size });
    for (const { base, runs } of lines) {
      for (const run of runs) {
        const span = svg('text', { x: run.x - x0, y: y1 - base, 'font-weight': run.bold ? 700 : 400 });
        if (run.source) span.classList.add('mw-source-tail');
        span.textContent = run.s;
        text.append(span);
      }
    }
    return text;
  }

  /** ページ pi の重ね表示を、今の marks に合わせて描く。 */
  function render(pi, state) {
    const marks = [...state.marks.values()].filter((m) => m.page === pi);
    if (!marks.length && !layers.has(pi)) return;
    const layer = layerOf(pi);
    if (!layer) return;
    const [x0, y0, x1, y1] = state.views[pi];
    layer.setAttribute('viewBox', `0 0 ${x1 - x0} ${y1 - y0}`);
    const backgrounds = marks.map(({ id, geometry: { box }, background, pieces }) => svg('rect', {
      class: 'mw-mark', 'data-mark-id': id, x: box.l - 1 - x0, y: y1 - box.t - 1,
      width: box.r - box.l + 2, height: box.t - box.b + 2,
      fill: `rgb(${background.join(',')})`, opacity: pieces.length ? 1 : 0.45,
    }));
    const texts = marks.filter((m) => m.pieces.length).map((m) => renderText(m, x0, y1));
    layer.replaceChildren(...backgrounds, ...texts);
  }

  store.subscribe((change, state) => {
    if (change.type === 'document' || change.type === 'reset') clear();
    else if (change.type === 'marks' || change.type === 'version') for (const pi of change.pages) render(pi, state);
  });

  // 取得中は代替フォントで描き、Workerが取得し終えたらキャッシュから同じフォントを読んで描き直す。
  return () => {
    fontLoad ??= loadFonts().then((fonts) => {
      measure = measureWithFonts(fonts);
      family = PDF_FONT_FAMILY;
      const { state } = store;
      for (const pi of new Set([...state.marks.values()].map((m) => m.page))) render(pi, state);
    }).catch(() => { fontLoad = undefined; });
  };
}
