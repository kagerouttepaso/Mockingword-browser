// 見出しの欄：PDF のしおり（アウトライン）を、折りたためるツリーで画面の左に出す。状態（ui/pdf-state.js）の知らせを受けて描く。
// 見出しを押すとその位置へ移る（pdf.js の PDFLinkService。移る前の位置は履歴に残り、「戻る」で戻れる）。
// 訳し終えた段落と同じ見出しは訳文で出す（対応は保存する PDF のしおりと同じ。pdf/titles.js の titleTranslations を Worker が送る）。
import { titleKey } from '../pdf/titles.js';

/** root（見出しの欄の要素）へ store の state.outline を描く。go(item) は見出しを押したときの移り先。 */
export function createOutline(store, root, go) {
  const titles = new Map(); // 見出しの鍵 → 訳文を入れる要素の配列

  function item(node, depth) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'ol-row';
    row.style.paddingInlineStart = `${depth * 14}px`;
    const twist = document.createElement('button');
    twist.className = 'ol-twist';
    twist.type = 'button';
    const link = document.createElement('a');
    link.className = 'ol-title';
    link.href = '#';
    link.title = node.title;
    const ja = document.createElement('span');
    ja.className = 'ol-ja';
    const orig = document.createElement('span');
    orig.className = 'ol-orig';
    orig.textContent = node.title;
    link.append(ja, orig);
    link.onclick = (e) => { e.preventDefault(); go(node); };
    const key = titleKey(node.title);
    if (!titles.has(key)) titles.set(key, []);
    titles.get(key).push(ja);
    row.append(twist, link);
    li.append(row);
    if (node.items?.length) {
      const ul = document.createElement('ul');
      for (const child of node.items) ul.append(item(child, depth + 1));
      li.append(ul);
      // はじめは全部開いておく（作者の希望。しおりの「開いて表示する」の指定には従わない）。押すと開く・閉じる
      const set = (open) => { li.classList.toggle('open', open); twist.setAttribute('aria-expanded', String(open)); twist.ariaLabel = open ? '閉じる' : '開く'; };
      set(true);
      twist.onclick = () => set(!li.classList.contains('open'));
    } else {
      twist.disabled = true;
    }
    return li;
  }

  function render(state) {
    titles.clear();
    root.replaceChildren();
    if (!state.outline?.length) {
      const p = document.createElement('p');
      p.className = 'ol-empty';
      p.textContent = 'このPDFには見出しの一覧（しおり）がありません';
      root.append(p);
      return;
    }
    const ul = document.createElement('ul');
    ul.className = 'ol-tree';
    for (const node of state.outline) ul.append(item(node, 0));
    root.append(ul);
  }

  store.subscribe((change, state) => {
    if (change.type === 'document') render(state);
    else if (change.type === 'reset') for (const list of titles.values()) for (const el of list) el.textContent = '';
    else if (change.type === 'titles') for (const [key, text] of state.titles) for (const el of titles.get(key) ?? []) el.textContent = text;
  });
}
