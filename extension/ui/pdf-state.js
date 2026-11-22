// PDF翻訳のページの状態の正本。状態を変えるのはここの関数だけで、変えたら購読者へ「何が変わったか」を知らせる。
// 画面は知らせを受けて描き、ページの描画完了をここの関数へ返す（docs/12_PDFの翻訳.md「表示」）。
//
// 状態：
//   mode      'translated'（訳文を見せる）・'original'（原文を見せる）
//   original  原文の PDF（pdf.js の文書）
//   latest    訳したPDFの最新の版（pdf.js の文書。Worker が書いたページを含む）。まだ無ければ null
//   written   訳したPDFに書いたページの番号。このページは訳文の表示で latest のページを出す
//   views     ページごとの範囲 [x0, y0, x1, y1]（PDF の点。pdf.js の page.view）
//   outline   しおり（pdf.js の getOutline の値。無ければ空）
//   marks     段落の番号 → { page, geometry, background, color, pieces, status }。status は 'working'（訳している）・'done'（訳文がそろい、
//             差し替え後の描画を待っている）
//   titles    見出しの鍵 → 訳した見出し（pdf/titles.js）
// 知らせ：{ type: 'document' }（別の PDF を開いた）・{ type: 'reset' }（訳文を全部捨てた）・{ type: 'marks', pages }（そのページの
//   重ね表示が変わった。fade が真なら徐々に消す）・{ type: 'abort' }（中止・失敗）・
//   { type: 'version', pages }（新しい版。pages は新しく書いたページ）・{ type: 'titles' }・{ type: 'mode' }

export function createStore() {
  const listeners = new Set();
  const state = { mode: 'translated', original: null, latest: null, written: new Set(), views: [], outline: [], marks: new Map(), titles: new Map() };
  const emit = (change) => { for (const fn of listeners) fn(change, state); };

  return {
    state,
    subscribe(fn) { listeners.add(fn); },
    /** PDF を開いた。前の PDF の訳文は捨てる。 */
    open(original, views, outline) {
      Object.assign(state, { original, latest: null, written: new Set(), views, outline: outline ?? [], marks: new Map(), titles: new Map() });
      emit({ type: 'document' });
    },
    /** 訳し始めた。前に訳した分は捨てる。 */
    begin() {
      Object.assign(state, { latest: null, written: new Set(), marks: new Map(), titles: new Map() });
      emit({ type: 'reset' });
    },
    /** Worker が知らせた段落の状態を反映する。status が null なら重ねた表示を消す。 */
    setMarks(list, status) {
      const pages = new Set();
      for (const p of list) {
        if (state.written.has(p.page)) continue;
        if (status) state.marks.set(p.id, { ...p, status });
        else state.marks.delete(p.id);
        pages.add(p.page);
      }
      if (pages.size) emit({ type: 'marks', pages });
    },
    /** 生成中の段落だけを更新する。確定した段落の訳文は途中経過で上書きしない。 */
    setPreview(list) {
      const pages = new Set();
      for (const { id, pieces } of list) {
        const mark = state.marks.get(id);
        if (mark?.status !== 'working') continue;
        mark.pieces = pieces;
        pages.add(mark.page);
      }
      if (pages.size) emit({ type: 'marks', pages });
    },
    /** 訳すのをやめた（失敗・取り消し）。重ね表示を消す。 */
    abort() {
      state.marks.clear();
      emit({ type: 'abort' });
    },
    /** 訳したPDFの新しい版 doc が届いた。pages はこの版で新しく書いたページ。 */
    addVersion(doc, pages) {
      state.latest = doc;
      for (const pi of pages) state.written.add(pi);
      emit({ type: 'version', pages: new Set(pages) });
    },
    /** 差し替えたページの重ね表示を消す。fade は表示中のページを描き終えたときだけ指定する。 */
    clearPageMarks(pages, fade = false) {
      if (!pages.size) return;
      const changed = new Set();
      for (const [id, mark] of state.marks) {
        if (!pages.has(mark.page)) continue;
        state.marks.delete(id);
        changed.add(mark.page);
      }
      if (changed.size) emit({ type: 'marks', pages: changed, fade });
    },
    setTitles(entries) {
      for (const [key, title] of entries) state.titles.set(key, title);
      emit({ type: 'titles' });
    },
    setMode(mode) {
      if (state.mode === mode) return;
      state.mode = mode;
      emit({ type: 'mode' });
    },
  };
}
