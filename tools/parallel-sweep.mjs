// 同時に訳す同時実行数を、設定の選択肢（1〜8本）より広く試す開発用の計測。同梱の wllama をそのまま使い、ビルド（Docker）は要らない。
// 実行：node tools/parallel-sweep.mjs [--plan 8x8,8x4,32x8,32x4,32x12,32x16,32x24,32x8] [--model 0.8B] [--out 結果.json]
//   plan の「NxP」は「N バッチを同時 P 本で」。各設定は読み込み・ウォームアップ1回のあと3回測って中央値を出す。
// 「このPCに合わせる」（background/tune.js）は8バッチ固定なので、8本を超える同時実行数の効き目はこちらで測る（docs/09「同時実行数の上限」）。
// 測っている間は、別の PowerShell で tools/sample-util.ps1 を回すと GPU と CPU の使用率を並べて見られる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, enableModelCache } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const model = opt('--model', '0.8B');
const plan = opt('--plan', '8x8,8x4,32x8,32x4,32x12,32x16,32x24,32x8').split(',').map((s) => s.split('x').map(Number));
if (!['0.8B', '2B'].includes(model) || plan.some(([n, p]) => !(n >= 1 && n <= 256 && p >= 1 && p <= 64))) throw new Error('--plan は 32x16 の形（バッチ1〜256、本数1〜64）、--model は 0.8B か 2B');

// 拡張の一時コピーに計測口を足す。リポジトリの拡張は変えない。
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-sweep-'));
fs.cpSync(path.join(HERE, '../extension'), ext, { recursive: true });
const patch = (file, from, to) => {
  const full = path.join(ext, file), text = fs.readFileSync(full, 'utf8');
  if (text.split(from).length !== 2) throw new Error(`${file} の差し込み位置を一意に特定できません`);
  fs.writeFileSync(full, text.replace(from, to));
};
patch('background/tune.js', 'const SAMPLE = [', 'export const SAMPLE = [');
// profile.mjs と同じく prompt キャッシュを効かせない（docs/09「計測の妥当性の見直し」）。
patch('offscreen/offscreen.js', '      prompt: message.prompt,', '      cache_prompt: false,\n      prompt: message.prompt,');
fs.writeFileSync(path.join(ext, 'background/sweep-harness.js'), `
import { complete, status } from '../core/engine.js';
import { settings } from './config.js';
import { SAMPLE } from './tune.js';
const LINES = SAMPLE.map((s) => s.split('\\n'));
// i 番目のバッチの j 行目は、(i + j*k) 番目の SAMPLE の j 行目（k = floor(i/8)）。1バッチの量は SAMPLE と同じで、32バッチまではすべて別の文になる。
const work = (n) => Array.from({ length: n }, (_, i) => LINES[i % 8].map((_, j) => LINES[(i + j * Math.floor(i / 8)) % 8][j]).join('\\n'));
async function round(n, options) {
  const queue = work(n);
  let tokens = 0, first = 0;
  const t0 = performance.now();
  const worker = async () => { while (queue.length) { const r = await complete(queue.shift(), options); first ||= performance.now() - t0; tokens += r.tokens ?? r.text.length; } };
  await Promise.all(Array.from({ length: Math.min(options.parallel, n) }, worker));
  return { ms: performance.now() - t0, first, tokens };
}
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
globalThis.__sweep = async (n, parallel, rounds = 3) => {
  const options = { ...(await settings()), device: 'gpu', parallel, debugLog: false, requestId: undefined };
  const t0 = performance.now();
  await complete('Warm up the model.', options);
  const loadMs = performance.now() - t0;
  const s = await status();
  await round(n, options);
  const rs = [];
  for (let i = 0; i < rounds; i++) rs.push(await round(n, options));
  const ms = median(rs.map((r) => r.ms)), tokens = median(rs.map((r) => r.tokens));
  return { n, parallel, device: s.device, adapter: s.adapter ?? null, loadMs: Math.round(loadMs), ms: Math.round(ms), all: rs.map((r) => Math.round(r.ms)), firstMs: Math.round(median(rs.map((r) => r.first))), tokens, tps: +((tokens / ms) * 1000).toFixed(1) };
};
`);
fs.appendFileSync(path.join(ext, 'background/main.js'), "\nimport './sweep-harness.js';\n");

const out = opt('--out', path.join(ext, 'result.json'));
const results = [];
const b = await launch({ extension: ext, extensionWaitMs: 0 });
try {
  await enableModelCache(b, { models: [model] });
  await b.eval(b.ext, `chrome.storage.sync.set(${JSON.stringify({ model, idleMinutes: 0, debugLog: false })})`);
  await b.eval(b.ext, `chrome.storage.local.set({ device: 'gpu', ubatch: 512, threads: 0 })`);
  await b.eval(b.ext, `chrome.runtime.sendMessage({ type: 'status' })`);
  const sw = await b.waitFor(async () => (await b.targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/background/main.js')), 20000, 100);
  if (!sw) throw new Error('拡張機能のService Workerが起動しませんでした');
  const session = await b.attach(sw.targetId);
  if (!await b.waitFor(() => b.eval(session, '!!globalThis.__sweep'), 10000, 100)) throw new Error('計測口が起動しませんでした');
  for (const [n, parallel] of plan) {
    const started = new Date().toISOString();
    try {
      const r = await b.eval(session, `globalThis.__sweep(${n}, ${parallel})`);
      results.push({ started, ...r });
      console.log(`${n}バッチ・同時${String(parallel).padStart(2)}本：${(r.ms / 1000).toFixed(2)}秒 [${r.all.map((x) => (x / 1000).toFixed(2)).join(', ')}]  最初 ${(r.firstMs / 1000).toFixed(2)}秒  ${r.tps} トークン/秒  ${r.device} ${r.adapter ?? ''}`);
    } catch (e) {
      results.push({ started, n, parallel, error: e?.message ?? String(e) });
      console.log(`${n}バッチ・同時${parallel}本：失敗 ${e?.message ?? e}`);
    }
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
  }
  console.log(`結果：${out}`);
} finally {
  await b.close();
}
