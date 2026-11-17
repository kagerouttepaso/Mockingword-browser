// しおりの見出しと、訳した段落の対応。保存する PDF のしおり（pdf/outline.js）と、PDF翻訳のページの見出しの欄（ui/pdf-outline.js）が同じ対応を使う。

/** しおりの見出しと本文の段落を突き合わせる鍵（マーカーと空白の違い、大文字・小文字を無視する）。 */
export const titleKey = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * 訳した段落（p.pieces のあるもの。pdf/write.js の prepare）から、しおりの見出しの鍵 → 訳した見出しを作る。
 * 保存する PDF のしおりと、PDF翻訳のページの見出しの欄（ui/pdf-outline.js）が同じ対応を使う。
 */
export function titleTranslations(paras) {
  return new Map(paras.filter((p) => p.pieces).map((p) => [titleKey(p.text), p.pieces.map((x) => x.text).join('').replace(/\s+/g, ' ').trim()]));
}

