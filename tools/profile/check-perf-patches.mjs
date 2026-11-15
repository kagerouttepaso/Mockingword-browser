// 固定版のローカルmirrorから一時ソースを作り、実ビルドと同じ順にオフライン照合する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { instrumentWebGpu } from './instrument-webgpu.mjs';
import { patchPaths } from '../wllama/patch-plan.mjs';
const recipe = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../wllama');
const pins = JSON.parse(fs.readFileSync(path.join(recipe, 'pins.json'), 'utf8'));
const mirrorRoot = process.env.PLAMO_GIT_MIRRORS ?? path.join(process.env.LOCALAPPDATA, 'plamo-translate-build/git');
const source = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-perf-check-'));
const paths = [...new Set(['build', 'commands', 'sampling', 'matmul', 'profile'].flatMap((stage) => fs.readdirSync(path.join(recipe, 'patches', stage)).filter((name) => name.endsWith('.patch')).flatMap((name) => patchPaths(fs.readFileSync(path.join(recipe, 'patches', stage, name), 'utf8')))))];
paths.push('llama.cpp/ggml/src/ggml-backend.cpp');
function git(args) { return execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }); }
function extract(name, pin, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const selected = name === 'llama.cpp' ? paths.filter((name) => name.startsWith('llama.cpp/')).map((name) => name.slice(10)) : paths.filter((name) => !name.startsWith('llama.cpp/'));
  const archive = execFileSync('git', [`--git-dir=${path.join(mirrorRoot, name + '.git')}`, 'archive', pin.commit, ...selected], { maxBuffer: 128 * 1024 * 1024 });
  const result = spawnSync('tar', ['-xf', '-', '-C', destination], { input: archive });
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
extract('wllama', pins.wllama, source);
extract('llama.cpp', pins.llamaCpp, path.join(source, 'llama.cpp'));
if (process.argv.includes('--pristine-only')) { console.log(JSON.stringify({ source })); process.exit(0); }
git(['init', '--quiet']);
for (const stage of ['build', 'commands', 'sampling', 'matmul', 'profile']) {
  for (const name of fs.readdirSync(path.join(recipe, 'patches', stage)).filter((name) => name.endsWith('.patch')).sort()) {
    const patch = path.join(recipe, 'patches', stage, name);
    git(['apply', '--check', patch]); git(['apply', patch]);
    console.log(`${stage}/${name}: git apply --check OK`);
  }
}
for (const name of ['plamo-profile.h', 'plamo-profile.cpp']) fs.copyFileSync(path.join(recipe, 'patches/profile', name), path.join(source, 'cpp', name));
const gpu = path.join(source, 'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp');
const result = instrumentWebGpu(fs.readFileSync(gpu, 'utf8'));
fs.writeFileSync(gpu, result.source);
console.log(JSON.stringify({ source, apiSites: result.counts, variants: ['profile', 'profile-gpu'] }));
