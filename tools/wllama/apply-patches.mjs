import fs from 'node:fs';
import path from 'node:path';
import { RECIPE, sha256, hashFile } from './support.mjs';
import { patchSections } from './patch-plan.mjs';
import { instrumentWebGpu } from '../profile/instrument-webgpu.mjs';

export async function applyBuildPatches(plan, source, runDirectory, execute) {
  fs.mkdirSync(path.join(runDirectory, 'patch-inputs'), { recursive: true });
  const applied = [];
  for (let i = 0; i < plan.patches.length; ++i) {
    const patch = plan.patches[i];
    // GPU部分は候補適用後のAPI位置へ差し込む。それ以外は固定版のパッチをそのまま照合する。
    const bytes = patch.stage === 'profile' ? Buffer.from(patchSections(patch.text).filter((section) => !section.startsWith('diff --git a/llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp ')).join('')) : patch.bytes;
    const file = path.join(runDirectory, 'patch-inputs', `${String(i).padStart(3, '0')}-${patch.sha256.slice(0, 12)}.patch`);
    fs.writeFileSync(file, bytes);
    if (bytes.length) {
      await execute('git', ['-C', source, 'apply', '--check', file]);
      await execute('git', ['-C', source, 'apply', file]);
    }
    applied.push({ stage: patch.stage, file: patch.file, sha256: patch.sha256, appliedSha256: sha256(bytes) });
  }
  let instrumentation = null;
  if (plan.variant.startsWith('profile')) {
    for (const file of ['plamo-profile.h', 'plamo-profile.cpp']) fs.copyFileSync(path.join(RECIPE, 'patches/profile', file), path.join(source, 'cpp', file));
    const file = path.join(source, 'llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp');
    const result = instrumentWebGpu(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, result.source);
    instrumentation = { adapter: 'profile/instrument-webgpu.mjs', apiSites: result.counts, webgpuSourceSha256: hashFile(file) };
  }
  return { applied, instrumentation };
}
