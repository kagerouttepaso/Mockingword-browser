// 元のcheckoutは読み取りだけにし、OSのTEMP内の一時コピーで適用を検証する。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPlan, loadPatchGroups, patchPaths } from '../../patch-plan.mjs';
import { applyBuildPatches } from '../../apply-patches.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const recipe = path.resolve(here, '../..');
const [wllamaSource, llamaSource] = process.argv.slice(2).map(p => path.resolve(p));
assert(wllamaSource && llamaSource, '引数: wllama checkout と llama.cpp checkout');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-gpu-kernels-verify-'));
const env = { ...process.env, GIT_CEILING_DIRECTORIES: os.tmpdir() };
const groupNames = ['commands', 'sampling', 'matmul', 'result', 'prefill', 'attn'];
const pins = JSON.parse(fs.readFileSync(path.join(recipe, 'pins.json')));
const plan = buildPlan('profile-gpu', pins, loadPatchGroups(groupNames.map(n => path.join(recipe, 'patches', n)).join(',')));
const applied = [];
try {
  for (const rel of new Set(plan.patches.flatMap(p => patchPaths(p.text)))) {
    const source = rel.startsWith('llama.cpp/') ? path.join(llamaSource, rel.slice(10)) : path.join(wllamaSource, rel);
    const dest = path.join(temporary, 'source', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  }
  const result = await applyBuildPatches(plan, path.join(temporary, 'source'), temporary, async (cmd, args) => {
    const r = spawnSync(cmd, args, { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
    if (args.includes('--check')) applied.push(path.basename(args.at(-1)));
  });
  const shader = fs.readFileSync(path.join(temporary, 'source/llama.cpp/ggml/src/ggml-webgpu/wgsl-shaders/flash_attn_tile.wgsl'), 'utf8');
  assert(shader.includes('workgroupUniformLoad(&mask_tile_visible)'));
  assert(shader.includes('var<workgroup> mask_tile_visible: atomic<u32>;'));
  assert(!shader.includes('subgroupAny('));
  assert(!shader.includes('workgroupUniformLoad(&p_shmem['));
  assert(shader.includes('bitcast<u32>(vec2<f16>(mask[mask_idx], f16(0.0))) & 0xffffu'));
  assert(shader.includes('lane_visible = lane_visible || mask_bits != 0xfc00u;'));
  assert(!/bitcast\s*<\s*f32\s*>\s*\(\s*0xff800000u\s*\)/i.test(shader));
  assert(shader.indexOf('if (tile_visible == 0u)') < shader.indexOf('load_k_tile_block('));
  const cpp = fs.readFileSync(path.join(temporary, 'source/llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp'), 'utf8');
  assert(cpp.includes('shader_lib_ctx.wg_mem_limit_bytes       = ctx->global_ctx->capabilities.limits.maxComputeWorkgroupStorageSize;'));
  const lib = fs.readFileSync(path.join(temporary, 'source/llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu-shader-lib.hpp'), 'utf8');
  assert(lib.includes('decisions->tile_n              = tile_n;'));
  assert(lib.includes('context.wg_mem_limit_bytes - (key.common.has_mask ? sizeof(uint32_t) : 0u)'));

  // 実shaderのmask走査を模し、部分タイル・inactive行・subgroup幅を照合する。
  let maskCases = 0, softmaxCases = 0;
  let seed = 20261110;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 2 ** 32;
  const f32 = Math.fround;
  function attention(rows, kLen, tile, skip, bias = 0) {
    const output = rows.map(() => ({ max: -1e9, sum: 0, value: 0 }));
    for (let base = 0; base < kLen; base += tile) {
      const end = Math.min(kLen, base + tile);
      if (skip && bias <= 0 && rows.every(row => row.slice(base, end).every(m => m === -Infinity))) continue;
      rows.forEach((mask, q) => {
        const s = output[q];
        const scores = mask.slice(base, end).map((m, k) => f32(Math.sin((base + k + 1) * (q + 1)) + m));
        const maximum = Math.max(s.max, -1e9, ...scores);
        const factor = f32(Math.exp(s.max - maximum));
        s.value = f32(s.value * factor); s.sum = f32(s.sum * factor);
        scores.forEach((score, k) => {
          const p = f32(Math.exp(score - maximum));
          s.sum = f32(s.sum + p);
          s.value = f32(s.value + f32(p * Math.cos(base + k)));
        });
        s.max = maximum;
      });
    }
    return output.map(s => s.sum ? f32(s.value / s.sum) : 0);
  }
  for (const tile of [16, 32, 64]) for (const kLen of [1, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 511, 512]) {
    for (let active = 1; active <= 4; active++) for (let mode = 0; mode < 8; mode++) {
      const rows = Array.from({ length: active }, (_, q) => Array.from({ length: kLen }, (_, k) => {
        if (mode === 0) return -Infinity;
        if (mode === 1) return 0;
        if (mode === 2) return k <= q + 2 ? 0 : -Infinity;
        if (mode === 3) return Math.floor(k / 53) === q ? 0 : -Infinity;
        if (mode === 4) return k === kLen - 1 && q === active - 1 ? 0 : -Infinity;
        if (mode === 5) return -65504;
        if (mode === 6) return random() > 0.92 ? -2 : -Infinity;
        return k >= kLen - 17 && k <= kLen - 3 ? 0 : -Infinity;
      }));
      for (const wgSize of [64, 128, 256]) for (let base = 0; base < kLen; base += tile) {
        let sum = 0;
        const count = Math.min(tile, kLen - base);
        for (let lane = 0; lane < wgSize; lane++) {
          let visible = false;
          for (let elem = lane; elem < 4 * count; elem += wgSize) {
            const q = Math.floor(elem / count), k = elem % count;
            visible ||= q < active && rows[q][base + k] !== -Infinity;
          }
          sum += Number(visible);
        }
        assert.equal(sum === 0, rows.every(row => row.slice(base, base + tile).every(m => m === -Infinity)));
        maskCases++;
      }
      assert.deepEqual(attention(rows, kLen, tile, true), attention(rows, kLen, tile, false));
      softmaxCases++;
    }
  }
  assert(Number.NaN !== -Infinity && -65504 !== -Infinity);
  // f16全ビット列を独立に復号し、-infだけが省略される契約を確認する。
  const bitsView = new DataView(new ArrayBuffer(4));
  let halfBitCases = 0;
  for (let bits = 0; bits < 65536; bits++) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >>> 10) & 31, fraction = bits & 1023;
    const value = exponent === 31 ? (fraction ? NaN : sign * Infinity) :
      sign * (exponent ? 1 + fraction / 1024 : fraction / 1024) * 2 ** (exponent ? exponent - 15 : -14);
    bitsView.setUint16(0, bits, true);
    bitsView.setUint16(2, 0, true);
    assert.equal((bitsView.getUint32(0, true) & 0xffff) === 0xfc00, value === -Infinity);
    halfBitCases++;
  }
  // K-quantの4要素デコード、32x64出力の端数と共有領域の被覆を確認する。
  let matmulCases = 0;
  for (const n of [9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 66, 117, 225, 395, 454, 512]) {
    const visits = new Uint8Array(37 * n);
    for (let wn = 0; wn < Math.ceil(n / 64); wn++) for (let wm = 0; wm < 2; wm++) {
      for (let lane = 0; lane < 64; lane++) for (let tn = 0; tn < 8; tn++) for (let tm = 0; tm < 4; tm++) {
        const m = wm * 32 + (lane % 8) * 4 + tm, col = wn * 64 + Math.floor(lane / 8) * 8 + tn;
        if (m < 37 && col < n) visits[col * 37 + m]++;
      }
    }
    assert(visits.every(v => v === 1)); matmulCases++;
  }
  assert.equal(2 * 64 * (8 * 4 + 8 * 8), 12288);
  const validation = { patchOrder: groupNames, gitApplyChecks: applied.length, profileInstrumentation: result.instrumentation?.apiSites,
    maskCases, softmaxCases, halfBitCases, matmulCases, gpuCompilation: '統率者が実施', actualGpuPerformance: '統率者が実施' };
  fs.writeFileSync(path.join(temporary, 'validation.json'), JSON.stringify(validation, null, 2) + '\n');
  console.log(JSON.stringify(validation, null, 2));
} finally {
  console.log(`検証資料: ${temporary}`);
}
