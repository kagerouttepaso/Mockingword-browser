import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPE, inside, hashFile } from '../wllama/support.mjs';
import { validateArtifacts } from '../wllama/patch-plan.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROTECTED = new Set(['prompt', 'stream', 'onData', 'abortSignal', 'stop', 'max_tokens', 'temperature', '__proto__', 'constructor', 'prototype']);
export function completionOptions(value = '{}') {
  const options = typeof value === 'string' ? JSON.parse(value.startsWith('@') ? fs.readFileSync(path.resolve(value.slice(1)), 'utf8').replace(/^\uFEFF/, '') : value) : value;
  if (!options || Array.isArray(options) || typeof options !== 'object') throw new Error('completion-extraはJSONオブジェクトです');
  for (const key of Object.keys(options)) if (PROTECTED.has(key)) throw new Error(`計測条件を保つため${key}は上書きできません`);
  return { ...options };
}
export function resolveArtifact(root, spec) {
  if (spec === 'distribution') return { artifact: spec, variant: spec, manifest: null, directory: null };
  let directory, pointer;
  if (typeof spec === 'object') directory = inside(root, path.resolve(root, spec.directory));
  else {
    if (!/^(baseline|profile|profile-gpu)(-candidate-[a-f0-9]{12})?$/.test(spec)) throw new Error(`成果物IDが不正です: ${spec}`);
    pointer = JSON.parse(fs.readFileSync(path.join(root, 'latest', `${spec}.json`), 'utf8'));
    directory = inside(root, pointer.artifactDirectory ? path.resolve(root, pointer.artifactDirectory) : path.join(root, 'runs', pointer.runId, 'artifacts'));
  }
  const manifest = validateArtifacts(directory, pointer?.inputHash);
  return { artifact: manifest.artifactId ?? manifest.variant, variant: manifest.variant, manifest, directory };
}
function once(file, before, after) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.split(before).length !== 2) throw new Error(`一時拡張のアンカーが一致しません: ${file}`);
  fs.writeFileSync(file, text.replace(before, after));
}
export function stageExtension(root, snapshot, destination, spec, options = {}) {
  inside(root, destination);
  if (fs.existsSync(destination)) throw new Error('一時拡張のフォルダーが既にあります');
  fs.cpSync(snapshot, destination, { recursive: true });
  const resolved = options.resolved ?? resolveArtifact(root, spec);
  if (resolved.variant === 'distribution') {
    const pins = JSON.parse(fs.readFileSync(path.join(RECIPE, 'pins.json'), 'utf8'));
    if (hashFile(path.join(destination, 'vendor/wllama/index.js')) !== pins.distribution.indexSha256 || hashFile(path.join(destination, 'vendor/wllama/wasm/wllama.wasm')) !== pins.distribution.wasmSha256) throw new Error('配布物のSHA-256が固定値と一致しません');
  } else for (const file of ['index.js', 'wasm/wllama.wasm']) fs.copyFileSync(path.join(resolved.directory, file), path.join(destination, 'vendor/wllama', file));
  fs.copyFileSync(path.join(HERE, 'offscreen-hook.js'), path.join(destination, 'offscreen/profile-hook.js'));
  fs.copyFileSync(path.join(HERE, 'background-harness.js'), path.join(destination, 'background/profile-harness.js'));
  fs.appendFileSync(path.join(destination, 'offscreen/offscreen.js'), "\nimport './profile-hook.js';\n");
  fs.appendFileSync(path.join(destination, 'background/main.js'), "\nimport './profile-harness.js';\n");
  once(path.join(destination, 'background/tune.js'), 'const SAMPLE = [', 'export const SAMPLE = [');
  if (options.nativeLog) {
    const file = path.join(destination, 'offscreen/offscreen.js');
    const text = fs.readFileSync(file, 'utf8');
    if ((text.match(/suppressNativeLog\s*:\s*(?:true|false)/g) ?? []).length !== 1) throw new Error('suppressNativeLogの設定位置を一意に特定できません');
    fs.writeFileSync(file, text.replace(/suppressNativeLog\s*:\s*(?:true|false)/, 'suppressNativeLog: false'));
  }
  const extra = completionOptions(options.completionExtra ?? {});
  if (options.tokens) { extra.verbose = true; extra.return_tokens = true; }
  if (Object.keys(extra).length) once(path.join(destination, 'offscreen/offscreen.js'), '      prompt: message.prompt,', `      ...${JSON.stringify(extra)},\n      prompt: message.prompt,`);
  if (options.tokens || extra.verbose || extra.return_tokens) {
    fs.copyFileSync(path.join(HERE, 'token-hook.js'), path.join(destination, 'offscreen/profile-token-hook.js'));
    fs.copyFileSync(path.join(HERE, 'token-utils.mjs'), path.join(destination, 'offscreen/profile-token-utils.mjs'));
    fs.appendFileSync(path.join(destination, 'offscreen/offscreen.js'), "\nimport './profile-token-hook.js';\n");
  }
  return resolved.manifest;
}
// 前後の基準を残しつつ、1回の起動で3回の測定と追加試行をまとめる。
export function sessionOrder(cases) {
  if (cases.length === 1) return [cases[0]];
  return [...cases, ...cases.slice(0, -1).reverse()];
}
