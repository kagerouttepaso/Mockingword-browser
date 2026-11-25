// 訳している段落に、訳し終えた文と薄くした残りの原文を重ねる。訳文が届くまでは原文を薄く見せる。
// 状態（ui/pdf-state.js）の marks を知らせのたびに描く。表示中のページが差し替わり、描き終わったら重ねた表示を徐々に消す。
//
// 層はページごとに1つの要素で、重ねた表示がある間は使い回す。座標はページに対する割合なので、拡大縮小しても描き直さない。
// pdf.js はページを描き直すとき（拡大縮小・見えなくなったページの破棄・ページの差し替え）にページの要素の子を消すので、
// ページの要素の子の変化を見て層をページへ置き直す。
import { pdfFontOf } from '../shared/languages.js';
import { loadFonts, measureWithFonts } from '../pdf/fonts.js';
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
  let fontKind = null;

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

  function removeLayer(pi) {
    const layer = layers.get(pi);
    if (!layer) return;
    layer.observer.disconnect();
    layer.el.remove();
    layers.delete(pi);
  }

  function fadeLayer(pi) {
    const el = layers.get(pi)?.el;
    if (!el) return;
    el.classList.add('mw-fading');
    const [transition] = el.getAnimations();
    if (!transition) return removeLayer(pi);
    const remove = () => { if (layers.get(pi)?.el === el) removeLayer(pi); };
    transition.finished.then(remove, remove);
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
    if (state.mode === 'original') return;
    const marks = [...state.marks.values()].filter((m) => m.page === pi);
    if (!marks.length) return removeLayer(pi);
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
    if (['document', 'reset', 'abort', 'mode'].includes(change.type)) {
      for (const pi of layers.keys()) removeLayer(pi);
      if (change.type === 'mode' && state.mode === 'translated') renderAll(state);
    } else if (change.type === 'marks') {
      for (const pi of change.pages) {
        if (change.fade) fadeLayer(pi);
        else render(pi, state);
      }
    }
  });

  function renderAll(state) {
    for (const pi of new Set([...state.marks.values()].map((m) => m.page))) render(pi, state);
  }

  // 取得中は代替フォントで描き、Workerが取得し終えたらキャッシュから同じフォントを読んで描き直す。
  // target は訳文の言語。画面で言語を変えて訳し直したら、その言語のフォントを読み直す。
  return (target) => {
    const kind = pdfFontOf(target);
    if (!kind) return;
    if (kind !== fontKind) {
      fontKind = kind;
      fontLoad = undefined;
    }
    fontLoad ??= loadFonts(kind).then((fonts) => {
      if (kind !== fontKind) return; // 読む間に別の言語へ変えた
      measure = measureWithFonts(fonts);
      family = fonts.family;
      renderAll(store.state);
    }).catch(() => { if (kind === fontKind) fontLoad = undefined; });
  };
}
