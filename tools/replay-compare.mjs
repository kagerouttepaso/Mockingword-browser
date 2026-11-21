// tools/page-replay.mjs の結果（--out に出る reference-1.json など）どうしで、訳の品質を比べる。
// 1つ目を参照訳とし、2つ目以降の各版について、参照との chrF（文字 n-gram の F スコア）、同じ訳の数、崩れの数を出す。
// 実行：node tools/replay-compare.mjs <参照.json> <版A.json> [<版B.json> ...] [--out 対訳.md]
//   参照には「1段落ずつ」（PLaMo の SaaS と同じ段落単位）の版や、2B の版を使う。正解訳ではないので、差の大きい段落は対訳で読んで判断する。
import fs from 'node:fs';
import path from 'node:path';
import { qualityStats, scoreAgainst } from './profile/replay-quality.mjs';

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (files.length < 2) { console.log('使い方：node tools/replay-compare.mjs <参照.json> <版A.json> [...] [--out 対訳.md]'); process.exit(2); }
const load = (file) => {
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { name: path.basename(path.dirname(file)) + '/' + path.basename(file, '.json'), pairs: result.run.pairs,
    quality: result.quality ?? (result.ux ? null : qualityStats(result.run.pairs, result.traces)),
    totalMs: result.run.totalMs, inventorySha256: result.inventorySha256, fixtureSha256: result.fixtureSha256 };
};
const [ref, ...cands] = files.map(load);
if (cands.some((candidate) => candidate.inventorySha256 !== ref.inventorySha256 || candidate.fixtureSha256 !== ref.fixtureSha256)) {
  throw new Error('同じ保存ページ・ビューポート・分母の結果を指定してください');
}
const cell = (s) => s.replace(/\|/g, '\\|');
const lines = [`参照：${ref.name}（${ref.pairs.length}段落）`, '', '| 版 | 参照との chrF | 同じ訳 | 依頼 | 行がずれた依頼 | 打ち切り | マーカー残り | 英字のまま | 全体 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
const details = [];
for (const c of [ref, ...cands]) {
  const s = scoreAgainst(ref.pairs, c.pairs), q = c.quality;
  const total = Number.isFinite(c.totalMs) ? `${(c.totalMs / 1000).toFixed(1)}秒` : '未到達';
  lines.push(`| ${c.name} | ${s.chrF ?? '—'} | ${s.same}/${s.paragraphs} | ${q?.requests ?? '—'} | ${q?.fallbackRequests ?? '—'} | ${q?.cutGenerations ?? '—'} | ${q?.brokenMarks ?? '—'} | ${q?.untranslated ?? '—'} | ${total} |`);
  if (c !== ref) details.push('', `## ${c.name}：参照との差が大きい段落`, '', '| chrF | 原文 | 参照 | この版 |', '| ---: | --- | --- | --- |', ...s.worst.filter((w) => w.score < 100).map((w) => `| ${w.score.toFixed(0)} | ${cell(w.source)} | ${cell(w.reference)} | ${cell(w.candidate)} |`));
}
console.log(lines.join('\n'));
if (out) fs.writeFileSync(out, `# 訳の比較\n\n${lines.join('\n')}\n${details.join('\n')}\n`);
