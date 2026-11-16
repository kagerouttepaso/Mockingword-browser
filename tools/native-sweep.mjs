// ネイティブ（llama-server、Vulkan）で、tools/parallel-sweep.mjs と同じ計測対象・プロンプト・同時実行数を測る。
// 条件は docs/09「ネイティブとの比較」と同じ：同時実行数＋1のスロット、--swa-full、-ngl 99 -b 2048 -ub 512、cache_prompt: false。
// 実行：node tools/native-sweep.mjs <llama-server.exe> <model.gguf> [--plan 8x4,8x8,32x4,32x8,32x16] [--out 結果.json]
//   plan の「NxP」は parallel-sweep.mjs と同じ。拡張と同じ GGUF（WORK/models の照合済みの物）を渡すと、出力トークン数まで一致する。
//   ブラウザーで翻訳しながら測ると値が乱れる（docs/09「ネイティブとの比較」）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const extDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const [server, model, ...rest] = process.argv.slice(2);
if (!server || !model) throw new Error('llama-server.exe と model.gguf のパスを渡してください');
const opt = (name, fallback) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : fallback);
const plan = opt('--plan', '8x4,8x8,32x4,32x8,32x16').split(',').map((s) => s.split('x').map(Number));
const out = opt('--out', null);
const { buildPrompt, maxTokensFor, STOP } = await import(pathToFileURL(path.join(extDir, 'shared/prompt.js')));
const tuneSrc = fs.readFileSync(path.join(extDir, 'background/tune.js'), 'utf8');
const SAMPLE = eval(tuneSrc.slice(tuneSrc.indexOf('const SAMPLE = [') + 'const SAMPLE = '.length, tuneSrc.indexOf("].map((lines) => lines.join('\\n'));") + 1)).map((l) => l.join('\n'));
const LINES = SAMPLE.map((s) => s.split('\n'));
const work = (n) => Array.from({ length: n }, (_, i) => LINES[i % 8].map((_, j) => LINES[(i + j * Math.floor(i / 8)) % 8][j]).join('\n'));
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const PORT = 18090;

async function startServer(parallel) {
  const slots = parallel + 1;
  const p = spawn(server, ['-m', model, '--host', '127.0.0.1', '--port', String(PORT), '-ngl', '99', '-b', '2048', '-ub', '512', '-np', String(slots), '-c', String(slots * 2048), '--swa-full', '--no-webui'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  p.stderr.on('data', (d) => { log = (log + d).slice(-4000); });
  for (let i = 0; i < 600; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return { p }; } catch {}
    if (p.exitCode !== null) throw new Error('llama-server が終了しました\n' + log.slice(-2000));
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('llama-server が起動しませんでした');
}

async function complete(text) {
  const r = await fetch(`http://127.0.0.1:${PORT}/completion`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: buildPrompt(text), n_predict: maxTokensFor(text), temperature: 0, stop: STOP, cache_prompt: false }),
  });
  const j = await r.json();
  return { text: j.content, tokens: j.tokens_predicted };
}

async function round(n, parallel) {
  const queue = work(n);
  let tokens = 0, first = 0;
  const t0 = performance.now();
  const worker = async () => { while (queue.length) { const r = await complete(queue.shift()); first ||= performance.now() - t0; tokens += r.tokens; } };
  await Promise.all(Array.from({ length: Math.min(parallel, n) }, worker));
  return { ms: performance.now() - t0, first, tokens };
}

const results = [];
for (const [n, parallel] of plan) {
  const s = await startServer(parallel);
  try {
    await complete('Warm up the model.');
    await round(n, parallel);
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await round(n, parallel));
    const ms = median(rs.map((r) => r.ms)), tokens = median(rs.map((r) => r.tokens));
    const r = { n, parallel, ms: Math.round(ms), all: rs.map((r) => Math.round(r.ms)), firstMs: Math.round(median(rs.map((r) => r.first))), tokens, tps: +((tokens / ms) * 1000).toFixed(1) };
    results.push({ started: new Date().toISOString(), ...r });
    console.log(`ネイティブ ${n}バッチ・同時${String(parallel).padStart(2)}本：${(r.ms / 1000).toFixed(2)}秒 [${r.all.map((x) => (x / 1000).toFixed(2)).join(', ')}]  最初 ${(r.firstMs / 1000).toFixed(2)}秒  ${r.tps} トークン/秒`);
  } finally {
    s.p.kill();
    await new Promise((r) => setTimeout(r, 1500));
  }
}
if (out) fs.writeFileSync(out, JSON.stringify(results, null, 2));
