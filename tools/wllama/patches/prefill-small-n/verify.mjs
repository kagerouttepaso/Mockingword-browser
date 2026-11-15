// 固定ソースへ実際のビルド順で適用し、C++から抽出した選択式と状態遷移をJSで検証する。
// C++/WGSLのコンパイルと実GPUでの訳・時間の確認は、別途ビルド後に行う。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPlan, loadPatchGroups, patchPaths } from '../../patch-plan.mjs';
import { applyBuildPatches } from '../../apply-patches.mjs';
import { analyzeEvents } from '../../../lib/perf-trace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const [wllama, llamaCpp, traceFile] = process.argv.slice(2).map((p) => path.resolve(p));
assert.ok(wllama && llamaCpp, 'node verify.mjs WLLAMA_GIT LLAMA_CPP_GIT（bare mirrorも可）');
const pins = JSON.parse(fs.readFileSync(path.join(here, '../../pins.json'), 'utf8'));
const base = ['commands', 'sampling', 'matmul', 'result', 'prefill', 'matmul-h8', 'attn', 'prefill-m8'];
const groups = (names) => loadPatchGroups(names.map((g) => path.join(here, '..', g)).join(','));
const matrix = [
  ['baseline', [...base, 'prefill-small-n']],
  ['baseline', [...base, 'sampling-stable']],
  ...['baseline', 'profile', 'profile-gpu'].map((v) => [v, [...base, 'prefill-small-n', 'sampling-stable']]),
].map(([v, g]) => buildPlan(v, pins, groups(g)));
const fixture = fs.mkdtempSync(path.join(here, '.verify-'));
// 親のworktreeが見つかるとgit applyがパスをskipする。独立したコピーとして適用させる。
const env = { ...process.env, GIT_CEILING_DIRECTORIES: fixture };
const native = (command, args) => execFileSync(command, command === 'git' ? ['-c', 'core.longpaths=true',
  '-c', `safe.directory=${wllama.replaceAll('\\', '/')}`, '-c', `safe.directory=${llamaCpp.replaceAll('\\', '/')}`, ...args] : args,
  { env, encoding: 'utf8', maxBuffer: 20e6, stdio: ['pipe', 'pipe', 'pipe'] });
const read = (root, file) => fs.readFileSync(path.join(root, 'llama.cpp', file), 'utf8');

async function checkTiles(source, showTrace = false) {
  const header = read(source, 'ggml/src/ggml-webgpu/ggml-webgpu-shader-lib.hpp');
  const region = header.slice(header.indexOf('        const bool flat =', header.indexOf('get_mul_mat_fast_pipeline(')),
    header.indexOf('        auto it = mul_mat_fast_pipelines.find(key);'));
  assert.ok(region.includes('key.small_n_tile ='));
  const body = region.replaceAll('->', '.').replace(/const (?:bool|int64_t|uint32_t) /g, 'const ')
    .replace('(uint32_t) (', 'Math.floor(').replace(/(\d+)u\b/g, '$1');
  const select = new Function('context', 'key', 'src_overlap', `const GGML_TYPE_Q4_K=4, GGML_TYPE_Q6_K=6, GGML_TYPE_F32=32,
    GGML_WEBGPU_MMVQ_MAX_ROWS=16, WEBGPU_MUL_MAT_WG_SIZE_N=8;
    ${body}; return key.small_n_tile;`);
  const context = (n, changes = {}) => ({ src0: { ne: [1536, 1536, 1, 1] },
    src1: { ne: [1536, n, 1, 1] }, dst: { ne: [1536, n, 1, 1] }, wg_mem_limit_bytes: 16384, ...changes });
  const key = (type = 4, subgroup = false) => ({ src0_type: type, src1_type: 32, use_subgroup_matrix: subgroup, small_n_tile: 0, small_n_m4: false });
  for (const type of [4, 6]) for (let n = 1; n <= 512; n++) {
    const k = key(type), tn = select(context(n), k);
    const width = tn ? tn * 8 : 64;
    assert.equal(tn !== 0, n > 16 && n <= 64, `N=${n}, type=${type}`);
    assert.equal(k.small_n_m4, n > 16 && n <= 64);
    if (!tn) continue;
    assert.ok(width >= n && width - n < 8);
    assert.equal(Math.ceil(n / width), 1, '重みの展開回数を増やさない');
    const tmSize = k.small_n_m4 ? 4 : 8, mWidth = tmSize * 8;
    assert.ok(mWidth * 64 * 2 + width * 64 * 2 <= 16384, '共有メモリー上限');
    assert.equal(Math.ceil(1536 / mWidth) * mWidth * 1536, 1536 * 1536, 'Mを分割しても重みの総展開量を保つ');
    // shaderのlocal_m/local_n、出力端のmaskと同じ写像で、全要素を1回ずつ保存できる。
    const stores = new Uint8Array(64 * n);
    for (let wgM = 0; wgM < 64 / mWidth; wgM++) for (let tid = 0; tid < 64; tid++) for (let tm = 0; tm < tmSize; tm++) for (let t = 0; t < tn; t++) {
      const m = wgM * mWidth + tid % 8 * tmSize + tm, col = Math.floor(tid / 8) * tn + t;
      if (col < n) stores[col * 64 + m]++;
    }
    assert.ok(stores.every((count) => count === 1), '出力の欠落・重複なし');
  }
  for (const [ctx, k] of [[context(26), key(2)], [context(26), key(4, true)],
    [context(26, { wg_mem_limit_bytes: 12288 }), key()],
    [context(26, { src0: { ne: [1536, 1536, 2, 1] } }), key()],
    [context(26, { src1: { ne: [1536, 26, 1, 2] } }), key()],
    [context(26, { src0: { ne: [1504, 1536, 1, 1] } }), key()],
    [context(26, { dst: { ne: [1504, 26, 1, 1] } }), key()]]) assert.equal(select(ctx, k), 0);
  assert.match(header, /small_n_tile == other\.small_n_tile/);
  assert.match(header, /small_n_m4 == other\.small_n_m4/);
  assert.match(header, /ggml_webgpu_hash_combine\(seed, key\.small_n_tile\)/);
  assert.match(header, /ggml_webgpu_hash_combine\(seed, key\.small_n_m4\)/);
  assert.match(header, /tile_n = key\.small_n_tile \? key\.small_n_tile : 8u/);
  assert.match(header, /decisions->tile_n\s*= tile_n/);
  const wide = { src0: { ne: [1536, 12288, 1, 1] }, dst: { ne: [12288, 32, 1, 1] } };
  const wideKey = key();
  assert.equal(select(context(32, wide), wideKey), 4);
  assert.equal(wideKey.small_n_m4, false, 'FFNの大きい出力はm8を保つ');
  assert.equal(select(context(64, { ...wide, dst: { ne: [12288, 64, 1, 1] } }), key()), 0);
  assert.match(header, /tile_m = key\.small_n_m4 \? 4u : 8u/);
  assert.equal(select(context(44), { ...key(), src1_type: 16 }, false), 0, 'F16活性は既存のpipelineに限定');
  assert.equal(select(context(44), key(), true), 0, '同じbuffer内の入力は既存のpipelineに限定');

  // Nの偶奇を含む実際のkey生成を使う。量子化型ではvectorizedは常に0となる。
  const fastStart = header.indexOf('    webgpu_pipeline get_mul_mat_fast_pipeline(');
  const keyPrefix = header.slice(header.indexOf('        key.src0_type', fastStart), header.indexOf('        // One N tile only:', fastStart))
    .replaceAll('->', '.');
  const initialKey = new Function('context', 'src_overlap', `const GGML_TYPE_F32=32, GGML_TYPE_F16=16;
    const key={small_n_tile:0,small_n_m4:false}; ${keyPrefix} return key;`);
  const fullKey = (ctx, overlap = false) => { const k = initialKey(ctx, overlap); select(ctx, k, overlap); return k; };
  const typedContext = (n, type, m, k = 1536) => ({ ...context(n),
    src0: { type, ne: [k, m, 1, 1] }, src1: { type: 32, ne: [k, n, 1, 1] }, dst: { type: 32, ne: [m, n, 1, 1] },
    supports_subgroup_matrix: false });
  const warmStart = header.indexOf('    void warm_kquant_small_n_pipelines(');
  let warmBody = header.slice(header.indexOf('{', warmStart) + 1, header.indexOf('    webgpu_pipeline get_count_equal_pipeline(', warmStart));
  warmBody = warmBody.slice(0, warmBody.lastIndexOf('}'))
    .replace('ggml_tensor src0 = {}, src1 = {}, dst = {};', 'const src0={ne:[]},src1={ne:[]},dst={ne:[]};')
    .replace('ggml_webgpu_shader_lib_context warm = {};', 'const warm={};')
    .replaceAll('&src0', 'src0').replaceAll('&src1', 'src1').replaceAll('&dst', 'dst')
    .replace('for (const auto type : { GGML_TYPE_Q4_K, GGML_TYPE_Q6_K })', 'for (const type of [GGML_TYPE_Q4_K,GGML_TYPE_Q6_K])')
    .replace('for (const int64_t m : { src0.ne[0], 2 * src0.ne[0] })', 'for (const m of [src0.ne[0],2*src0.ne[0]])')
    .replaceAll('const uint32_t ', 'const ').replaceAll('for (uint32_t ', 'for (let ').replace(/(\d+)u\b/g, '$1');
  const warm = new Function('get_mul_mat_fast_pipeline', `const GGML_TYPE_F32=32, GGML_TYPE_Q4_K=4,GGML_TYPE_Q6_K=6,
    WEBGPU_MUL_MAT_WG_SIZE_N=8, wg_mem_limit_bytes=16384, ggml_blck_size=()=>256; ${warmBody}`);
  const cache = new Set(), encode = (k) => JSON.stringify(k);
  warm((ctx, overlap) => {
    ctx.supports_subgroup_matrix = false;
    const k = fullKey(ctx, overlap);
    assert.notEqual(k.small_n_tile, 0, '先行準備は新しいpipelineだけ');
    assert.equal(k.vectorized, 0); assert.equal(k.src_overlap, false);
    cache.add(encode(k));
  });
  assert.equal(cache.size, 22, 'モデル読み込み中に2量子化型×(m4の6種+m8の5種)を準備する');
  // 前版はn3だけの存在で全種類の先行準備を省いていた。部分cacheでも全種類を列挙する。
  const partial = new Set([encode(fullKey(typedContext(21, 4, 1536)))]);
  warm((ctx, overlap) => { ctx.supports_subgroup_matrix = false; partial.add(encode(fullKey(ctx, overlap))); });
  assert.deepEqual([...partial].sort(), [...cache].sort(), 'n3が既にあってもn6/n7を含む全22種がそろう');
  for (const type of [4, 6]) for (let n = 17; n <= 64; n++) for (const [m, k] of [[1536,1536],[1536,6144],[2304,1536],[12288,1536]]) {
    const actual = fullKey(typedContext(n, type, m, k));
    assert.equal(actual.vectorized, 0, 'Nが4の倍数かどうかは量子化型のkeyへ影響しない');
    if (actual.small_n_tile) assert.ok(cache.has(encode(actual)), `事前準備にないkey: ${encode(actual)}`);
  }
  assert.match(header, /warm_kquant_small_n_pipelines\(wg_mem_limit_bytes\);/);
  assert.match(header, /if \(!supports_subgroup_matrix && wg_mem_limit_bytes >= 16384u\)/);
  assert.ok(!header.includes('// Model warmup uses large N.'), '翻訳中の先行作成を削除');
  assert.match(read(source, 'ggml/src/ggml-webgpu/ggml-webgpu.cpp'), /global_ctx->device, dev_ctx->webgpu_global_ctx->instance,/);
  assert.match(header, /key.small_n_tile \?\s*ggml_webgpu_create_pipeline_ready\(device, instance, processed, variant\)/);
  await checkReadyWait(header);
  if (traceFile && showTrace) {
    const data = JSON.parse(fs.readFileSync(traceFile, 'utf8')), seen = new Set(), rows = [];
    let preparedSeen = 0;
    for (const step of analyzeEvents(data.events).steps) {
      const first = Object.keys(step.gpu ?? {}).filter((name) => /^mul_mat_reg_tile_q[46]_K_n[3-8]k64_m[48]_f32$/.test(name) && !seen.has(name));
      for (const name of first) {
        seen.add(name);
        const [, type, tn, tm] = name.match(/_q([46])_K_n([3-8])k64_m([48])_f32$/);
        const probe = typedContext(Number(tn) * 8, Number(type), Number(tm) === 4 ? 256 : 512, 256);
        const k = fullKey(probe);
        if (k.small_n_tile) { assert.ok(cache.has(encode(k)), name); preparedSeen++; }
      }
      if (first.length) rows.push({ n: step.tokens, prefill: step.prefillTokens, ms: step.ms, mapMs: step.metrics.mapWait?.ms, first });
    }
    console.log(JSON.stringify({ trace: path.basename(traceFile), recordedPipelines: seen.size, firstUseKeysCovered: preparedSeen, rows }));
  }
  console.log('N15: 22種の先行準備、全N=17..64の実keyとの一致、async完了待ちと失敗経路を確認');
}

async function checkReadyWait(header) {
  const start = header.indexOf('    static webgpu_pipeline ggml_webgpu_create_pipeline_ready(');
  const end = header.indexOf('    static webgpu_pipeline ggml_webgpu_create_pipeline(', start);
  const method = header.slice(start, end);
  let body = method.slice(method.indexOf('        wgpu::ComputePipeline ready;'), method.lastIndexOf('}'))
    .replace('wgpu::ComputePipeline ready;', 'let ready=null;').replace('std::string error;', 'let error="";')
    .replaceAll('const auto ', 'const ').replace('instance.WaitAny(', 'await instance.WaitAny(')
    .replace('[&](wgpu::CreatePipelineAsyncStatus status, wgpu::ComputePipeline pipeline, wgpu::StringView message)', '(status,pipeline,message) =>')
    .replaceAll('wgpu::CreatePipelineAsyncStatus::Success', '"Success"').replaceAll('wgpu::WaitStatus::Success', '"Success"')
    .replaceAll('wgpu::CallbackMode::WaitAnyOnly', '"WaitAnyOnly"').replaceAll('std::string(message)', 'String(message)')
    .replaceAll('nullptr', 'null').replaceAll('.c_str()', '').replace('&desc', 'desc');
  assert.ok(!method.includes('CreateComputePipeline('), '完了前のsync handleへ戻さない');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const create = new AsyncFunction('device', 'instance', 'GGML_ABORT', `const desc={},label='test',UINT64_MAX=Infinity; ${body}`);
  for (const outcome of ['Success','ValidationError','CallbackCancelled','wait-failed']) {
    let callback, settled = false, called = false;
    const device = { CreateComputePipelineAsync: (_desc, mode, cb) => { called = true; assert.equal(mode,'WaitAnyOnly'); callback=cb; return 1; } };
    const instance = { WaitAny: async () => {
      await Promise.resolve();
      if (outcome === 'wait-failed') return 'Error';
      settled = true; callback(outcome, outcome === 'Success' ? { ready:true } : null, outcome);
      return 'Success';
    } };
    const pending = create(device, instance, (...args) => { throw new Error(args.join(' ')); });
    assert.equal(called,true); assert.equal(settled,false);
    if (outcome === 'Success') assert.equal((await pending).ready.ready,true);
    else await assert.rejects(pending, /was not ready/);
  }
}

function checkSamplers(source) {
  const sampling = read(source, 'common/sampling.cpp');
  let eligibility = sampling.slice(sampling.indexOf('static bool token_only_eligible('), sampling.indexOf('\nstruct common_sampler * common_sampler_init('));
  eligibility = eligibility.slice(eligibility.indexOf('{') + 1, eligibility.lastIndexOf('}'))
    .replace(/([\w.]+)\.empty\(\)/g, '($1.length === 0)').replaceAll('.back()', '.at(-1)')
    .replace('for (const auto sampler : p.samplers)', 'for (const sampler of p.samplers)')
    .replace(/(\d+\.\d+)f\b/g, '$1');
  const enums = [...new Set(eligibility.match(/COMMON_SAMPLER_TYPE_\w+/g))];
  const eligible = new Function('p', ...enums, eligibility);
  const temperature = 'COMMON_SAMPLER_TYPE_TEMPERATURE';
  const params = (changes = {}) => ({ backend_sampling: true, backend_sampling_token_only: true,
    n_probs: 0, temp: 0, dynatemp_range: 0, mirostat: 0, grammar: '', grammar_lazy: false,
    grammar_triggers: [], preserved_tokens: [], logit_bias: [], ignore_eos: false,
    penalty_repeat: 1, penalty_freq: 0, penalty_present: 0, dry_multiplier: 0,
    xtc_probability: 0, typ_p: 1, adaptive_target: -1, top_n_sigma: -1,
    reasoning_budget_tokens: -1, reasoning_control: false, samplers: [temperature], ...changes });
  const init = (p) => { p.backend_sampling_token_only = eligible(p, ...enums); return { serial: ++serial }; };
  let serial = 0, calls = 0, reserve = false;
  const attached = new Map();
  const set = (_ctx, id, sampler) => {
    calls++;
    if (!sampler && !attached.has(id)) return true;
    reserve = true;
    if (sampler) attached.set(id, sampler); else attached.delete(id);
    return true;
  };
  const server = read(source, 'tools/server/server-context.cpp');
  let transition = server.slice(server.indexOf('            const bool token_only ='), server.indexOf('            SLT_TRC(slot, "sampler chain:'))
    .replaceAll('const bool ', 'const ').replaceAll('.samplers.size()', '.samplers.length')
    .replace('std::move(next_sampler)', 'next_sampler').replace('common_sampler_get(slot.smpl.get())', 'slot.smpl');
  const reset = server.match(/        if \(!token_only_sampler\) \{\n            llama_set_sampler\(ctx_tgt, id, nullptr\);\n        \}/)?.[0];
  assert.ok(reset);
  const release = new Function('slot', 'llama_set_sampler', reset.replace('!token_only_sampler', '!slot.token_only_sampler')
    .replace('ctx_tgt, id, nullptr', 'null, slot.id, null'));
  transition = transition.replaceAll('nullptr', 'null');
  // Functionを実行する前に、C++のnull表現だけを置き換える。
  const runStart = new Function('task', 'slot', 'next_sampler', 'use_backend_sampling', 'ctx_tgt', 'llama_set_sampler', temperature, transition);
  const slots = Array.from({ length: 9 }, (_, id) => {
    const p = params(), smpl = init(p);
    assert.equal(p.backend_sampling_token_only, true);
    set(null, id, smpl);
    return { id, smpl, token_only_sampler: true };
  });
  // 起動時の全スロット登録後は、開始・正常終了・取消相当のreleaseがreserveを立てない。
  reserve = false; calls = 0;
  for (let round = 0; round < 200; round++) for (const slot of slots) {
    const p = params(), next = init(p), previous = slot.smpl;
    runStart({ params: { sampling: p } }, slot, next, true, null, set, temperature);
    assert.equal(slot.smpl, previous);
    release(slot, set);
    assert.equal(attached.get(slot.id), previous);
  }
  assert.equal(reserve, false); assert.equal(calls, 0); assert.equal(attached.size, 9);
  const fallbacks = [{ temp: 0.7 }, { n_probs: 5 }, { grammar: 'root ::= "x"' }, { penalty_repeat: 1.1 },
    { backend_sampling: false }, { backend_sampling_token_only: false }, { samplers: [temperature, temperature] }];
  for (const changes of fallbacks) {
    const slot = slots[0], p = params(changes), next = init(p), previous = slot.smpl;
    reserve = false;
    runStart({ params: { sampling: p } }, slot, next, p.backend_sampling, null, set, temperature);
    assert.notEqual(slot.smpl, previous); assert.equal(slot.smpl, next);
    assert.equal(slot.token_only_sampler, false); assert.equal(reserve, true);
    release(slot, set); assert.equal(attached.has(slot.id), false);
    const greedy = params(), again = init(greedy);
    runStart({ params: { sampling: greedy } }, slot, again, true, null, set, temperature);
    assert.equal(slot.token_only_sampler, true); release(slot, set);
    assert.equal(attached.get(slot.id), again);
  }
  assert.match(server, /if \(!spec && !mctx && !params_base.embedding\)/);
  assert.match(server, /task\.type == SERVER_TASK_TYPE_COMPLETION && !spec/);
  assert.match(server, /llama_set_sampler\(ctx_tgt, slot.id, nullptr\);\n            slot.token_only_sampler = false;\n            slot.smpl.reset\(\);/);
  console.log('N1: 抽出したeligibilityと状態遷移で9スロット×200回の開始・終了、7種のfallbackと復帰を確認');
}

try {
  const pristine = path.join(fixture, 'pristine');
  const files = new Set(matrix.flatMap((p) => p.patches.flatMap((patch) => patchPaths(patch.text))));
  for (const file of files) {
    const llama = file.startsWith('llama.cpp/');
    const bytes = native('git', ['-C', llama ? llamaCpp : wllama, 'show', `${llama ? pins.llamaCpp.commit : pins.wllama.commit}:${llama ? file.slice(10) : file}`]);
    const target = path.join(pristine, file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  }
  for (const [index, plan] of matrix.entries()) {
    const run = path.join(fixture, `run-${index}`), source = path.join(run, 'source');
    fs.cpSync(pristine, source, { recursive: true });
    const applied = await applyBuildPatches(plan, source, run, native);
    if (index === 0 || index >= 2) await checkTiles(source, index === 0);
    if (index === 1 || index >= 2) checkSamplers(source);
    assert.equal(applied.applied.length, plan.patches.length);
    console.log(`${plan.artifactId}: ${plan.patches.length}パッチを実適用${applied.instrumentation ? '、GPU計測挿入も確認' : ''}`);
  }
} finally {
  const target = fs.realpathSync(fixture), parent = fs.realpathSync(here);
  assert.equal(path.dirname(target), parent);
  assert.ok(path.basename(target).startsWith('.verify-'));
  fs.rmSync(target, { recursive: true });
}
