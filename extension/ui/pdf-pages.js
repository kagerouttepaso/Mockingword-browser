// ページの差し替え：pdf.js のビューアの各ページに、状態（ui/pdf-state.js）から決まる文書のページを出す。
//   原文の表示、または訳したPDFにまだ書いていないページ → 原文の PDF のページ
//   訳文の表示で、書いたページ → 訳したPDFの版のページ
// 差し替えるのは出すべき文書が変わったページだけ（PDFPageView.setPdfPage）で、ほかのページは描き直さない。訳したPDFの版は
// PDFium が文書全体を保存したもので、ページの番号付け（リンクの飛び先が指す番号）は原文と同じなので、リンクは原文の文書の
// PDFLinkService のまま働く。
//
// 新しい版が届いたとき、描いてあるページで中身の変わらないもの（前の版で書いたページ）は前の版のまま出しておき、描いていない
// ページだけを最新の版へ移す（描き直さない）。前の版は、出しているページが無くなったら閉じる（メモリーに残すのは原文、最新の版、
// 描いてあるページが使っている版だけ）。描いてあるページを差し替えると pdf.js は描き終わるまでページを空にするので、
// 差し替える前の絵の写しと訳文の重ね表示を、差し替えたページを描き終わるまで残す。

const INITIAL = 0; // pdf.js の RenderingStates.INITIAL（描いていない）

export function createPages(store, viewer, eventBus) {
  const shown = new Map(); // ページの番号 → 出している文書（無ければ原文）
  const versions = new Set(); // 開いている訳したPDFの版
  const covers = new Map(); // ページの番号 → 差し替え中に重ねている絵の写し
  let token = 0;

  eventBus.on('pagerendered', ({ source, pageNumber, cssTransform, error }) => {
    const pi = pageNumber - 1;
    if (cssTransform || error || source !== viewer.getPageView(pi)) return;
    covers.get(pi)?.remove();
    covers.delete(pi);
    const { mode, original, written } = store.state;
    if (mode === 'translated' && written.has(pi) && shown.has(pi) && shown.get(pi) !== original) {
      store.clearPageMarks(new Set([pi]), viewer._getVisiblePages().ids.has(pageNumber));
    }
  });

  /** 画面外では差し替え後の描画を待たずに、書いたページの重ね表示を消す。 */
  function discardOffscreenMarks() {
    const { mode, marks, written } = store.state;
    if (!marks.size || !written.size) return;
    const visible = viewer._getVisiblePages().ids;
    const pages = new Set();
    for (const { page } of marks.values()) {
      if (written.has(page) && (mode === 'original' || !visible.has(page + 1))) pages.add(page);
    }
    store.clearPageMarks(pages);
  }
  eventBus.on('updateviewarea', discardOffscreenMarks);

  /** 描いてある絵の写しを作る（差し替えた後にページへ重ね、描き終わったら外す）。 */
  function snapshot(pageView) {
    const canvas = pageView.canvas;
    if (pageView.renderingState === INITIAL || !canvas?.width) return null;
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d').drawImage(canvas, 0, 0);
    copy.className = 'mw-cover';
    return copy;
  }

  /**
   * 各ページに出すべき文書を出す。fresh はこの版で新しく書いたページ（描いてあっても差し替える）。
   * all が真なら、描いてあるページも全部差し替える（原文・訳文の切り替え）。
   */
  async function sync(state, { fresh = new Set(), all = false } = {}) {
    const my = ++token;
    const jobs = [];
    for (let pi = 0; pi < viewer.pagesCount; pi++) {
      const want = state.mode === 'translated' && state.written.has(pi) && state.latest ? state.latest : state.original;
      const now = shown.get(pi) ?? state.original;
      if (now === want) continue;
      const pageView = viewer.getPageView(pi);
      const drawn = pageView.renderingState !== INITIAL || covers.has(pi);
      // 前の版で書いたページは中身が同じなので、描いてあるならそのまま出しておく
      if (!all && drawn && now !== state.original && want !== state.original && !fresh.has(pi)) continue;
      jobs.push(want.getPage(pi + 1).then((page) => [pi, want, page]));
    }
    const pages = await Promise.all(jobs);
    if (my !== token) return; // もっと新しい状態で差し替え直している
    for (const [pi, want, page] of pages) {
      const pageView = viewer.getPageView(pi);
      const copy = covers.get(pi) ?? snapshot(pageView);
      // pdf.js の PDFPageView は、文字の層とリンクを読み上げ用に結び付ける TextAccessibilityManager を作り直さずに使い回す。
      // 別の文書のページに差し替えると、前のページの対応（リンクの要素の ID → 文字の番号）が残り、ID が同じ（版は番号付けが
      // 原文と同じ）新しいページで範囲外の文字を引いて文字の層の作成が止まった（日本語を選べず、描き直されないように見えた）。
      // 差し替えるときに捨て、次に描くときに作り直させる（pdf.js 4.10.38 の PDFPageView._accessibilityManager）。
      pageView._accessibilityManager = null;
      pageView.setPdfPage(page);
      if (copy) {
        pageView.div.append(copy);
        covers.set(pi, copy);
      }
      shown.set(pi, want);
    }
    if (pages.length) viewer.update();
    // 出しているページの無い古い版を閉じる
    const used = new Set(shown.values());
    for (const doc of versions) {
      if (doc !== state.latest && !used.has(doc)) {
        versions.delete(doc);
        doc.destroy();
      }
    }
  }

  store.subscribe((change, state) => {
    if (change.type === 'document') {
      // ページの要素は pdf.js が作り直すので、出している文書の記録と前の PDF の版を捨てる
      token++;
      for (const doc of versions) doc.destroy();
      versions.clear();
      shown.clear();
      covers.clear();
    } else if (change.type === 'reset') {
      sync(state, { all: true }).catch((e) => console.error(e)); // 訳し直す：書いたページを原文へ戻す（古い版は sync の最後に閉じる）
    } else if (change.type === 'version') {
      versions.add(state.latest);
      discardOffscreenMarks();
      sync(state, { fresh: change.pages }).catch((e) => console.error(e));
    } else if (change.type === 'mode') {
      store.clearPageMarks(state.written);
      sync(state, { all: true }).catch((e) => console.error(e));
    }
  });
}
