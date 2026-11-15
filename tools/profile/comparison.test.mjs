// 性能パッチの採否の関門。訳文を変える候補を受け入れると、同梱する wllama が訳を黙って変える（docs/06「試験」）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRuns, summarizeRounds, acceptanceForComparisons } from '../lib/perf-trace.mjs';

const result = (text, tokens = 10, cut = false) => ({ text, tokens, cut });
const round = (...results) => ({ ms: 100, firstMs: 50, tokens: results.reduce((sum, item) => sum + item.tokens, 0), results });
function run(variant, rounds, qualityReplays = []) {
  return { model: '0.8B', variant, rounds, qualityReplays, summary: summarizeRounds(rounds),
    quality: { text: '<a1>案内</a1>と<a2>窓口</a2>', cut: false } };
}

test('候補版の1回だけに出る別訳を、基準版でも揺れたと推定して受け入れない', () => {
  const reference = run('distribution', [round(result('1行目\n訳A')), round(result('1行目\n訳A'))]);
  const candidate = run('baseline', [round(result('1行目\n訳A')), round(result('1行目\n訳B', 11))]);
  assert.equal(acceptanceForComparisons(compareRuns([reference, candidate]))[0].ok, false);
});

test('打ち切りと目印の脱落は、訳文が同じでも受け入れない', () => {
  const reference = run('distribution', [round(result('訳A'))]);
  const cut = run('baseline', [round(result('訳A', 10, true))]);
  assert.equal(acceptanceForComparisons(compareRuns([reference, cut]))[0].ok, false);
  const markers = run('baseline', [round(result('訳A'))]);
  markers.quality = { text: '案内と窓口', cut: false };
  assert.equal(acceptanceForComparisons(compareRuns([reference, markers]))[0].ok, false);
});
