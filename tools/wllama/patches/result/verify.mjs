// 固定版のファイルだけを一時コピーし、パッチの適用と計測のキュー再生を検証する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { patchPaths, patchSections } from '../../patch-plan.mjs';
import { instrumentWebGpu } from '../../../profile/instrument-webgpu.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 3) throw new Error('node verify.mjs WLLAMA_REPO LLAMA_CPP_REPO ROUND_JSON');
const [wllama, llamaCpp, roundFile] = args.map((p) => path.resolve(p));
const pins = JSON.parse(fs.readFileSync(path.join(here, '../../pins.json'), 'utf8'));
const git = (repo, ...parameters) => execFileSync('git', ['-c', `safe.directory=${repo.replaceAll('\\', '/')}`, '-C', repo, ...parameters], { encoding: 'utf8' });
const files = (group) => fs.readdirSync(path.join(here, '..', group)).filter((f) => f.endsWith('.patch')).sort().map((f) => path.join(here, '..', group, f));
const groups = ['commands', 'sampling', 'matmul', 'result', 'profile'];
const patches = groups.flatMap((group) => files(group).map((file) => ({ group, file, text: fs.readFileSync(file, 'utf8') })));
const validationRoot = fs.mkdtempSync(path.join(here, '.validation-'));
let fixture = validationRoot;
try {
  for (const file of new Set(patches.flatMap((patch) => patchPaths(patch.text)))) {
    const isLlama = file.startsWith('llama.cpp/');
    const source = git(isLlama ? llamaCpp : wllama, 'show', `${isLlama ? pins.llamaCpp.commit : pins.wllama.commit}:${isLlama ? file.slice(10) : file}`);
    const target = path.join(fixture, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  for (const { group, file, text } of patches) {
    // ビルドと同じく、GPUの計測だけは候補適用後のソースへ挿入する。
    const body = group === 'profile' ? patchSections(text).filter((section) => !section.startsWith('diff --git a/llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp ')).join('') : text;
    for (const check of [true, false]) execFileSync('git', ['apply', '--no-index', ...(check ? ['--check'] : []), '-'], { cwd: fixture, input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`${group}/${path.basename(file)}: 適用確認済み`);
  }
  const gpu = path.join(fixture, 'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp');
  const instrumented = instrumentWebGpu(fs.readFileSync(gpu, 'utf8'));
  assert.ok(instrumented.source.length);
  console.log('候補適用後のGPU計測挿入: 確認済み');
} finally {
  const resolved = fs.realpathSync(validationRoot), root = fs.realpathSync(here);
  assert.equal(path.dirname(resolved), root);
  assert.ok(path.basename(resolved).startsWith('.validation-'));
  fs.rmSync(resolved, { recursive: true });
}

const data = JSON.parse(fs.readFileSync(roundFile, 'utf8'));
const steps = data.events.flatMap((event) => event.steps ?? []);
const active = steps.filter((step) => step.tokens > 0);
const idle = steps.filter((step) => !step.tokens);
const polls = data.events.filter((event) => event.kind === 'action' && event.action === 'get_result');
const taskIds = [...new Set(active.flatMap((step) => step.sequences.map((q) => q.requestId)))].sort((a, b) => a - b);
const requestIds = [...new Set(polls.map((p) => p.requestId))].sort((a, b) => a - b);
assert.equal(taskIds.length, data.round.results.length);
const lastStep = new Map(taskIds.map((id) => [id, active.findLastIndex((step) => step.sequences.some((q) => q.requestId === id))]));
const sampled = taskIds.map((id) => active.filter((step) => step.sequences.some((q) => q.requestId === id)).length);
assert.deepEqual(sampled, data.round.results.map((r) => r.tokens));
assert.equal(steps.length, polls.length);
const nativeActiveMs = active.reduce((sum, step) => sum + step.ms, 0);
const nativeIdleMs = idle.reduce((sum, step) => sum + step.ms, 0);
const elapsedMs = steps.at(-1).endMs - steps[0].startMs;
const overheadPerPollMs = (elapsedMs - nativeActiveMs - nativeIdleMs) / polls.length;

function replay(patched, overhead = overheadPerPollMs) {
  const queues = taskIds.map(() => []), seen = new Set();
  const firstChunkMs = {}, finalMs = {};
  let nextStep = 0, idleCount = 0, ms = 0;
  for (const poll of polls) {
    const request = requestIds.indexOf(poll.requestId);
    if (!patched || queues[request].length === 0) {
      if (nextStep < active.length) {
        const step = active[nextStep];
        ms += step.ms;
        for (const sequence of step.sequences) {
          const index = taskIds.indexOf(sequence.requestId);
          if (!seen.has(index)) { queues[index].push('begin'); seen.add(index); }
          queues[index].push('token');
          if (lastStep.get(sequence.requestId) === nextStep) queues[index].push('final');
        }
        nextStep++;
      } else {
        if (!patched) ms += idle[idleCount]?.ms ?? 0;
        idleCount++;
      }
    }
    ms += overhead;
    const result = queues[request].shift();
    // 元のポーリング順で全チャンクを欠落なく読み切れることを照合する。
    assert.equal(result === undefined || result === 'begin', poll.empty, `callbackId=${poll.callbackId}`);
    if (result === 'token') firstChunkMs[poll.requestId] ??= ms;
    if (result === 'final') finalMs[poll.requestId] = ms;
  }
  assert.ok(queues.every((q) => q.length === 0));
  assert.equal(nextStep, active.length);
  assert.equal(Object.keys(finalMs).length, requestIds.length);
  return { idleCount, ms, firstMs: Math.min(...Object.values(finalMs)), firstChunkMs, finalMs };
}

const before = replay(false), after = replay(true);
assert.equal(before.idleCount, idle.length);
assert.equal(after.idleCount, 0);
assert.ok(Math.abs(before.ms - elapsedMs) < 0.01);
assert.ok(before.firstMs - after.firstMs > 250);
console.log(JSON.stringify({
  basis: '生成ステップの所要時間・所属・元のポーリング順を固定した反実仮想。実機予測の基準値。',
  node: process.version, platform: os.platform(), pins: { wllama: pins.wllama.commit, llamaCpp: pins.llamaCpp.commit },
  polls: polls.length, activeSteps: active.length, idleSteps: idle.length, nativeActiveMs, nativeIdleMs, overheadPerPollMs,
  before, after,
  sensitivity: [0.08, 0.15, 0.25].map((overhead) => { const r = replay(true, overhead); return { overheadPerPollMs: overhead, firstMs: r.firstMs, ms: r.ms }; }),
}, null, 2));
