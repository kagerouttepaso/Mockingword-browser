// 文末の判定。ページの途中表示と、表示された文を数える計測で使う。
const segmenter = new Intl.Segmenter('und', { granularity: 'sentence' });
const terminal = /\p{Sentence_Terminal}[\p{Close_Punctuation}\p{Final_Punctuation}"']*$/u;

/** 文末記号のある文の終端（後ろの空白を含まない）の並び。 */
export function sentenceEnds(text) {
  const ends = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const sentence = segment.trimEnd();
    if (/\p{L}/u.test(sentence) && terminal.test(sentence)) ends.push(index + sentence.length);
  }
  return ends;
}
