// 半透明の表示：訳している段落と、訳し終えてページに書かれるのを待っている段落の原文を薄く見せる（ページの翻訳の
// data-plamo-working と同じ見え方）。PDF の中身ではなく画面の表示なので、ページの上に重ねる。状態（ui/pdf-state.js）の
// marks を知らせのたびに描き直すだけで、状態は持たない。ページが訳したPDFに差し替わると、そのページの半透明の表示は無くなる。
//
// 層はページごとに1つの要素で、作ったら捨てずに使う。座標はページに対する割合なので、拡大縮小しても描き直さない。
// pdf.js はページを描き直すとき（拡大縮小・見えなくなったページの破棄・ページの差し替え）にページの要素の子を消すので、
// ページの要素の子の変化を見て層をページへ置き直す。

export function createOverlay(store, viewer) {
  const layers = new Map(); // ページの番号 → { el, observer }

  function layerOf(pi) {
    let layer = layers.get(pi);
    if (layer) return layer.el;
    const div = viewer.getPageView(pi)?.div;
    if (!div) return null;
    const el = document.createElement('div');
    el.className = 'mw-layer';
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

  /** ページ pi の半透明の表示を、今の marks に合わせて描き直す。 */
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
      el.dataset.state = m.status;
      Object.assign(el.style, {
        left: `${((m.box.l - 1 - x0) / W) * 100}%`, top: `${((y1 - m.box.t - 1) / H) * 100}%`,
        width: `${((m.box.r - m.box.l + 2) / W) * 100}%`, height: `${((m.box.t - m.box.b + 2) / H) * 100}%`,
        background: m.background ? `rgb(${m.background.join(',')})` : 'rgb(255,255,255)',
      });
      return el;
    }));
  }

  store.subscribe((change, state) => {
    if (change.type === 'document' || change.type === 'reset') clear();
    else if (change.type === 'marks' || change.type === 'version') for (const pi of change.pages) render(pi, state);
  });
}
