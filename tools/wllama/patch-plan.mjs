import fs from 'node:fs';
import path from 'node:path';
import { RECIPE, PROJECT, sha256, hashFile } from './support.mjs';

export function patchSections(text) { return text.replaceAll('\r\n', '\n').split(/(?=^diff --git )/m).filter((section) => section.startsWith('diff --git ')); }
export function patchPaths(text) {
  return [...new Set(patchSections(text).map((section) => {
    const match = section.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (!match || match[1] !== match[2] || path.posix.isAbsolute(match[2]) || match[2].split('/').some((part) => part === '..' || part === '.git')) throw new Error('同じ相対パスへの通常のパッチを指定してください（renameは未対応）');
    return match[2];
  }))];
}
export function loadPatchGroups(value) {
  if (!value) return [];
  const patches = [];
  for (const directory of value.split(',').map((entry) => path.resolve(entry))) {
    const files = fs.readdirSync(directory).filter((file) => file.endsWith('.patch')).sort();
    if (!files.length) throw new Error(`パッチがありません: ${directory}`);
    for (const file of files) {
      const bytes = fs.readFileSync(path.join(directory, file)), text = bytes.toString('utf8');
      patchPaths(text);
      const relative = path.relative(PROJECT, path.join(directory, file));
      patches.push({ stage: 'candidate', file: relative.startsWith('..') ? `external/${path.basename(directory)}/${file}` : relative.replaceAll(path.sep, '/'), sha256: sha256(bytes), bytes, text });
    }
  }
  if (new Set(patches.map((patch) => patch.sha256)).size !== patches.length) throw new Error('同じパッチを重複して指定しています');
  return patches;
}
export function buildPlan(variant, pins, candidatePatches = []) {
  const standard = [];
  for (const stage of ['build', ...(variant.startsWith('profile') ? ['profile'] : [])]) {
    for (const file of fs.readdirSync(path.join(RECIPE, 'patches', stage)).filter((file) => file.endsWith('.patch')).sort()) {
      const relative = `patches/${stage}/${file}`, bytes = fs.readFileSync(path.join(RECIPE, relative));
      standard.push({ stage, file: relative, sha256: sha256(bytes), bytes, text: bytes.toString('utf8') });
    }
  }
  const patches = [...standard.filter((patch) => patch.stage === 'build'), ...candidatePatches, ...standard.filter((patch) => patch.stage === 'profile')];
  const recipe = {};
  for (const file of ['Dockerfile', 'container-build.mjs', 'build.mjs', 'build-cache.mjs', 'support.mjs', 'patch-plan.mjs', 'apply-patches.mjs', 'timing.mjs', ...(variant.startsWith('profile') ? ['patches/profile/plamo-profile.h', 'patches/profile/plamo-profile.cpp', '../profile/instrument-webgpu.mjs'] : [])]) recipe[file] = hashFile(path.resolve(RECIPE, file));
  const semantic = { schema: 2, pins, variant, patches: patches.map(({ stage, sha256 }) => ({ stage, sha256 })), recipe };
  const inputHash = sha256(JSON.stringify(semantic));
  const candidateHash = candidatePatches.length ? sha256(JSON.stringify(candidatePatches.map((patch) => patch.sha256))) : null;
  const artifactId = variant + (candidateHash ? `-candidate-${candidateHash.slice(0, 12)}` : '');
  const cmakePatches = patches.flatMap((patch) => patchSections(patch.text).filter((section) => /^diff --git a\/.*(?:CMakeLists\.txt|\.cmake)\s/m.test(section))).map(sha256);
  const cmakeFlags = ['-DGGML_WEBGPU=ON', '-DGGML_WEBGPU_JSPI=ON', '-DWLLAMA_TEST_BACKEND=OFF', `-DGGML_WEBGPU_GPU_PROFILE=${variant === 'profile-gpu' ? 'ON' : 'OFF'}`];
  const configurationHash = sha256(JSON.stringify({ schema: 2, compilerContract: 'emscripten-jspi-memory64-o3-simd128-pthread-no-lto', pins, variant, cmakeFlags, cmakePatches, dockerfile: recipe.Dockerfile }));
  const changedPaths = [...new Set(patches.flatMap((patch) => patchPaths(patch.text)))];
  if (variant.startsWith('profile')) changedPaths.push('cpp/plamo-profile.h', 'cpp/plamo-profile.cpp');
  return { variant, artifactId, inputHash, configurationHash, cmakeFlags, changedPaths, candidateHash, patches, recipe, semantic };
}
export function validateArtifacts(directory, expectedHash) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'build-manifest.json'), 'utf8'));
  if (expectedHash && manifest.inputHash !== expectedHash) throw new Error('成果物の入力hashが一致しません');
  for (const file of ['index.js', 'wasm/wllama.wasm']) if (hashFile(path.join(directory, file)) !== manifest.files[file].sha256) throw new Error(`成果物のSHA-256が一致しません: ${file}`);
  return manifest;
}
