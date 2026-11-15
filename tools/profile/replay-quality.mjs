// tools/page-replay.mjs の訳の品質を、版どうしで比べられる形にまとめる。
// 正解訳はないので、機械的に数えられる崩れ（行のずれ・打ち切り・目印・英字のまま）と、版どうしで訳が変わった段落を出す。
// 変わった段落は対訳表にして、人が読んで良し悪しを判断する。

const MARK = /<\/?[ac]\d+>/;

/** 英字の語が残っているか。原文に英字の語が3つ以上あり、訳文の文字の半分以上が英字なら「英字のまま」と数える。 */
export function untranslated(source, translation) {
  const words = source.match(/[A-Za-z]{2,}/g) ?? [];
  if (words.length < 3) return false; // 製品名・ボタン名のような短い項目は、原文のままが正しいことが多い
  const letters = translation.replace(/\s/g, '');
  if (!letters.length) return true;
  return (letters.match(/[A-Za-z]/g) ?? []).length / letters.length >= 0.5;
}

/** 1回分の崩れを数える。traces は調査用のログ（裏方の「完了」に fallback、model の「生成」に cut が入る）。 */
export function qualityStats(pairs, traces) {
  return {
    paragraphs: pairs.length,
    requests: traces.filter((e) => e.source === '裏方' && e.event === '完了').length,
    fallbackRequests: traces.filter((e) => e.source === '裏方' && e.event === '完了' && e.fallback).length,
    cutGenerations: traces.filter((e) => e.source === 'model' && e.event === '生成' && e.cut).length,
    brokenMarks: pairs.filter((p) => MARK.test(p.translation)).length,
    untranslated: pairs.filter((p) => untranslated(p.source, p.translation)).length,
    empty: pairs.filter((p) => !p.translation).length,
  };
}

/** 2つの版の訳を原文で突き合わせる。同じ原文が複数あるときは最初の1つで比べる。 */
export function comparePairs(reference, candidate) {
  const ref = new Map();
  for (const p of reference) if (p.source && !ref.has(p.source)) ref.set(p.source, p.translation);
  const seen = new Set();
  const rows = [];
  let same = 0, missing = 0;
  for (const p of candidate) {
    if (!p.source || seen.has(p.source)) continue;
    seen.add(p.source);
    if (!ref.has(p.source)) { missing++; continue; }
    if (ref.get(p.source) === p.translation) same++;
    else rows.push({ source: p.source, reference: ref.get(p.source), candidate: p.translation });
  }
  return { compared: same + rows.length, same, changed: rows.length, missing, rows };
}

/**
 * 文字 n-gram の F スコア（chrF、n=1〜6、β=2、0〜100）。PFN の SaaS ベンチマークは参照訳との文字 n-gram 類似度（charsim）で採点しており、
 * その考え方を借りる。空白は除く（日本語は空白で語を区切らないため）。
 */
export function chrF(hypothesis, reference, { maxN = 6, beta = 2 } = {}) {
  const h = [...hypothesis.replace(/\s+/g, '')], r = [...reference.replace(/\s+/g, '')];
  if (!h.length && !r.length) return 100;
  let p = 0, rc = 0, orders = 0;
  for (let n = 1; n <= maxN; n++) {
    const count = (chars) => { const m = new Map(); for (let i = 0; i + n <= chars.length; i++) { const g = chars.slice(i, i + n).join(''); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
    const hg = count(h), rg = count(r);
    const hTotal = Math.max(0, h.length - n + 1), rTotal = Math.max(0, r.length - n + 1);
    if (!hTotal || !rTotal) continue;
    let match = 0;
    for (const [g, c] of hg) match += Math.min(c, rg.get(g) ?? 0);
    p += match / hTotal; rc += match / rTotal; orders++;
  }
  if (!orders) return 0;
  p /= orders; rc /= orders;
  return p + rc === 0 ? 0 : (100 * (1 + beta ** 2) * p * rc) / (beta ** 2 * p + rc);
}

/** 参照の版に対する各段落の chrF の平均（原文で突き合わせ、重複した原文は最初の1つ）。 */
export function scoreAgainst(reference, candidate) {
  const ref = new Map();
  for (const p of reference) if (p.source && !ref.has(p.source)) ref.set(p.source, p.translation);
  const scores = [];
  const seen = new Set();
  for (const p of candidate) {
    if (!p.source || seen.has(p.source) || !ref.has(p.source)) continue;
    seen.add(p.source);
    scores.push({ source: p.source, score: chrF(p.translation, ref.get(p.source)), reference: ref.get(p.source), candidate: p.translation });
  }
  const mean = scores.length ? scores.reduce((s, x) => s + x.score, 0) / scores.length : null;
  return { paragraphs: scores.length, chrF: mean === null ? null : +mean.toFixed(1), same: scores.filter((x) => x.reference === x.candidate).length, worst: [...scores].sort((a, b) => a.score - b.score).slice(0, 15) };
}

const cell = (s) => s.replace(/\|/g, '\\|');
/** 対訳表（Markdown）。 */
export function qualityReport({ names, stats, comparison, target }) {
  const lines = [`# 訳の比較：${target}`, '', '## 崩れの数', '', `| | ${names.join(' | ')} |`, `| --- | ${names.map(() => '---:').join(' | ')} |`];
  const labels = { paragraphs: '訳した段落', requests: '依頼', fallbackRequests: '行がずれて1行ずつ訳し直した依頼', cutGenerations: '止まらず打ち切った生成', brokenMarks: '目印が崩れた段落', untranslated: '英字のまま', empty: '訳が空' };
  for (const [k, label] of Object.entries(labels)) lines.push(`| ${label} | ${stats.map((s) => s[k]).join(' | ')} |`);
  lines.push('', `## 訳が変わった段落（${names[0]} と ${names[1]}）`, '', `原文で突き合わせた ${comparison.compared}段落のうち、同じ ${comparison.same}、変わった ${comparison.changed}（片方にしかない原文 ${comparison.missing}）。`, '', `| 原文 | ${names[0]} | ${names[1]} |`, '| --- | --- | --- |');
  for (const r of comparison.rows) lines.push(`| ${cell(r.source)} | ${cell(r.reference)} | ${cell(r.candidate)} |`);
  return lines.join('\n') + '\n';
}
