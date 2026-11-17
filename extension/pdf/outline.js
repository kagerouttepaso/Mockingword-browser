// しおり（アウトライン）の見出しを訳す。PDFium にはしおりを書き換える API が無いので、保存するときに pdf-lib で書き換える
// （pdf/finish.js）。訳文は本文の見出しの訳を使い、本文に同じ見出しが無いものは原文のまま残す。
import { PDFHexString, PDFName, PDFString } from '../vendor/pdf-lib/pdf-lib.esm.min.js';
import { titleKey, titleTranslations } from './titles.js';

/** pdf-lib の文書 doc のしおりを、訳した段落 paras（titleTranslations）で訳す。返す値：{ translated, total }。 */
export function translateOutline(doc, paras) {
  const byKey = titleTranslations(paras);
  const outlines = doc.catalog.lookup(PDFName.of('Outlines'));
  let translated = 0, total = 0;
  const seen = new Set();
  const walk = (ref) => {
    for (let r = ref; r && !seen.has(r); ) {
      seen.add(r);
      const node = doc.context.lookup(r);
      if (!node?.get) break;
      const title = node.lookup(PDFName.of('Title'));
      const text = title instanceof PDFHexString || title instanceof PDFString ? title.decodeText() : '';
      total++;
      const ja = byKey.get(titleKey(text));
      if (ja) { node.set(PDFName.of('Title'), PDFHexString.fromText(ja)); translated++; }
      walk(node.get(PDFName.of('First')));
      r = node.get(PDFName.of('Next'));
    }
  };
  walk(outlines?.get?.(PDFName.of('First')));
  return { translated, total };
}
