// 訳文の行分け。語を空白で区切る文字（ラテン文字・キリル文字・ハングルなど）の並びは分けず、漢字・かなと全角の記号は1文字ずつ折り返す。
// 行頭禁則の文字はぶら下げ、行末禁則の文字は次の行へ送る。
// 字幅は呼び出し側の measure（pdf/fonts.js）で測る。DOM にも PDFium にも触れない。

const NO_START = /^[、。，．・：；？！ー）」』】〕”’ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々.,:;!?)\]]/u;
const NO_END = /[（「『【〔“‘(\[]$/u;
/**
 * 分けない並び（空白・漢字・かな・全角の記号を含まない並び。ノーブレークスペースは並びに含める）、空白、それ以外の1文字。
 * 以前はラテン文字（U+024F まで）と一部の記号だけを並びにしていたので、キリル文字やベトナム語の文字（U+1EA0〜）の語を
 * 1文字ずつ折り返していた（2026-11-25、訳文の言語を選べるようにしたときに一般化した）。
 */
const ATOM = /(?:[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\u3000-\u303f\uff00-\uffef]|\u00a0)+|\s+|./gu;

/**
 * 書式つきの断片 [{ text, bold, link, source }] を幅 width（pt）で行に分ける。measure(text, bold, size) → 幅。
 * 返す値：行の配列。行は [{ s, w, pc }]（pc＝元の断片）。
 */
export function layout(pieces, width, size, measure) {
  const atoms = [];
  for (const pc of pieces) {
    for (const m of pc.text.matchAll(ATOM)) {
      const s = /^\s+$/.test(m[0]) ? ' ' : m[0];
      atoms.push({ s, w: measure(s, pc.bold, size), pc });
    }
  }
  const lines = [[]];
  let w = 0;
  for (const a of atoms) {
    const line = lines.at(-1);
    if (a.s === ' ' && !line.length) continue;
    if (w + a.w > width && line.length) {
      if (a.s === ' ') { lines.push([]); w = 0; continue; }
      if (NO_START.test(a.s) && a.s.length <= 2 && line.at(-1).pc.source === a.pc.source) { line.push(a); w += a.w; continue; }
      const carry = [];
      // 残りの原文を足しても、すでに置いた訳文の行は変えない。
      while (line.length > 1 && line.at(-1).pc.source === a.pc.source && NO_END.test(line.at(-1).s)) carry.unshift(line.pop());
      while (line.at(-1)?.s === ' ') line.pop();
      lines.push([...carry, a]);
      w = carry.reduce((sum, x) => sum + x.w, 0) + a.w;
      continue;
    }
    line.push(a);
    w += a.w;
  }
  for (const line of lines) while (line.at(-1)?.s === ' ') line.pop();
  return lines.filter((line) => line.length);
}
