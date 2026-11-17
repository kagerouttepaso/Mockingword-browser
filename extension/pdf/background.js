// 段落の背景色（原文を覆う四角の色）。原文のページを PDFium で描き、覆う四角の中で文字の下に見えている色を取る：
// 四角の中の画素から文字の色に近い画素を除き、最も多い色。四角の外（上下の縁）を見ると、行ごとに色の違う表の縞で
// 隣の行の色を拾った（Kvaser の取説の仕様の表。2026-11-17、作者の報告）。文字のにじみ（文字と背景の中間色）は値がばらけるので、
// 背景の1色より多くならない。
// 訳している段落の半透明の表示（ui/pdf-overlay.js）と、訳したPDFで埋め込みのフォームの中の文字を覆う四角（pdf/write.js）が
// 同じ色を使うよう、段落に p.background として持たせる。

const TEXT_DISTANCE = 64; // 文字の色からこの距離（RGB のユークリッド距離）より近い画素は文字として数えない

/** ページ pi を描いた画素から、(四角, 文字の色) → 四角の中の背景の色 [r, g, b] を返す関数を作る。 */
function sampler(X, pi) {
  const { P, M } = X;
  const page = P.FPDF_LoadPage(X.doc, pi);
  try {
    const W = Math.ceil(P.FPDF_GetPageWidthF(page)), H = Math.ceil(P.FPDF_GetPageHeightF(page));
    const bmp = P.FPDFBitmap_Create(W, H, 0);
    P.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xffffffff);
    P.FPDF_RenderPageBitmap(bmp, page, 0, 0, W, H, 0, 0);
    const ptr = P.FPDFBitmap_GetBuffer(bmp), stride = P.FPDFBitmap_GetStride(bmp);
    const px = M.HEAPU8.slice(ptr, ptr + stride * H);
    P.FPDFBitmap_Destroy(bmp);
    const clamp = (v, max) => Math.min(max - 1, Math.max(0, v));
    return (box, text) => {
      const count = new Map();
      const x0 = clamp(Math.floor(box.l), W), x1 = clamp(Math.ceil(box.r), W);
      const y0 = clamp(Math.floor(H - box.t), H), y1 = clamp(Math.ceil(H - box.b), H);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const o = y * stride + x * 4;
          const rgb = [px[o + 2], px[o + 1], px[o]];
          if (Math.hypot(rgb[0] - text[0], rgb[1] - text[1], rgb[2] - text[2]) < TEXT_DISTANCE) continue;
          const key = rgb.join(',');
          count.set(key, (count.get(key) ?? 0) + 1);
        }
      }
      const top = [...count].sort((a, b) => b[1] - a[1])[0];
      return top ? top[0].split(',').map(Number) : [255, 255, 255];
    };
  } finally {
    P.FPDF_ClosePage(page);
  }
}

/**
 * paras の段落に背景色 p.background（[r, g, b]）を付ける。付いている段落はそのまま。ページは原文のまま描く
 * （訳文を書く前に呼ぶ）。box(p) は覆う四角（pdf/plan.js の paragraphBox）。
 */
export function addBackgrounds(X, paras, box) {
  const samplers = new Map();
  for (const p of paras) {
    if (p.background) continue;
    if (!samplers.has(p.page)) samplers.set(p.page, sampler(X, p.page));
    p.background = samplers.get(p.page)(box(p), p.color);
  }
}
