// PDF翻訳のページの状態の正本。状態を変えるのはここの関数だけで、変えたら購読者へ「何が変わったか」を知らせる。
// 画面（ページの差し替え・半透明の表示・見出しの欄・ボタン）は知らせを受けて描くだけで、状態を持たない
// （一方向の流れ。docs/12_PDFの翻訳.md「表示」）。
//
// 状態：
//   mode      'translated'（訳文を見せる）・'original'（原文を見せる）
//   original  原文の PDF（pdf.js の文書）
//   latest    訳したPDFの最新の版（pdf.js の文書。Worker が書いたページを含む）。まだ無ければ null
//   written   訳したPDFに書いたページの番号。このページは訳文の表示で latest のページを出す
//   views     ページごとの範囲 [x0, y0, x1, y1]（PDF の点。pdf.js の page.view）
//   outline   しおり（pdf.js の getOutline の値。無ければ空）
//   marks     段落の番号 → { page, box, background, color, size, lead, pieces, status }。status は 'working'（訳している）・'done'（訳文がそろい、
//             ページに書かれるのを待っている）。書いたページの段落は持たない
//   titles    見出しの鍵 → 訳した見出し（pdf/titles.js）
// 知らせ：{ type: 'document' }（別の PDF を開いた）・{ type: 'reset' }（訳文を全部捨てた）・{ type: 'marks', pages }（そのページの
//   半透明の表示が変わった）・{ type: 'version', pages }（新しい版。pages は新しく書いたページ）・{ type: 'titles' }・{ type: 'mode' }

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
        if (status && !state.written.has(p.page)) state.marks.set(p.id, { ...p, status });
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
    /** 訳すのをやめた（失敗・取り消し）。半透明の表示を消す。 */
    abort() {
      const pages = new Set([...state.marks.values()].map((m) => m.page));
      state.marks.clear();
      emit({ type: 'marks', pages });
    },
    /** 訳したPDFの新しい版 doc が届いた。pages はこの版で新しく書いたページ（そのページの半透明の表示は消す）。 */
    addVersion(doc, pages) {
      state.latest = doc;
      for (const pi of pages) state.written.add(pi);
      for (const [id, m] of state.marks) if (state.written.has(m.page)) state.marks.delete(id);
      emit({ type: 'version', pages: new Set(pages) });
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
