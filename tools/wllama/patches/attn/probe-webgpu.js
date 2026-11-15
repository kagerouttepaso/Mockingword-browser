// 翻訳拡張のoffscreen DevToolsで実行し、実際のBrave adapterを記録する。
(async () => {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU adapterがありません');
  const info = adapter.info;
  const configs = info.subgroupMatrixConfigs ?? [];
  const result = {
    userAgent: navigator.userAgent,
    adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description },
    features: [...adapter.features].sort(),
    wgslFeatures: navigator.gpu.wgslLanguageFeatures ? [...navigator.gpu.wgslLanguageFeatures].sort() : [],
    subgroupMinSize: info.subgroupMinSize, subgroupMaxSize: info.subgroupMaxSize,
    maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    subgroupMatrixConfigs: Array.from(configs, c => ({ componentType: c.componentType, resultComponentType: c.resultComponentType,
      M: c.M, N: c.N, K: c.K, minSubgroupSize: c.minSubgroupSize, maxSubgroupSize: c.maxSubgroupSize })),
  };
  result.matrixGate = {
    feature: adapter.features.has('chromium-experimental-subgroup-matrix'),
    shaderF16: adapter.features.has('shader-f16'),
    subgroups: adapter.features.has('subgroups'),
    f16Configs: result.subgroupMatrixConfigs.filter(c => c.componentType === 'f16' && c.resultComponentType === 'f16'),
  };
  // 実行せずに、新しいmask分類の型・同期・uniformityをBraveでコンパイルする。
  const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });
  device.pushErrorScope('validation');
  try {
    const module = device.createShaderModule({ label: 'PLaMo H5 mask classifier probe', code: `
enable f16;
struct Params { seq_len_q: u32, seq_len_kv: u32, offset_mask: u32, max_bias: f32 };
@group(0) @binding(0) var<storage, read> mask: array<f16>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;
var<workgroup> mask_tile_visible: atomic<u32>;
@compute @workgroup_size(128)
fn main(@builtin(local_invocation_id) local_id: vec3<u32>, @builtin(workgroup_id) wg_id: vec3<u32>) {
    let q_row_start = wg_id.x * 4u;
    let mask_global_offset = params.offset_mask + q_row_start * params.seq_len_kv;
    for (var kv_tile = 0u; kv_tile < params.seq_len_kv; kv_tile += 64u) {
        let kv_count = min(64u, params.seq_len_kv - kv_tile);
        if (local_id.x == 0u) {
            atomicStore(&mask_tile_visible, select(1u, 0u, params.max_bias <= 0.0));
        }
        workgroupBarrier();
        if (params.max_bias <= 0.0) {
            var lane_visible = false;
            for (var elem = local_id.x; elem < 4u * kv_count; elem += 128u) {
                let q_row = elem / kv_count;
                let k_rel = elem % kv_count;
                if (q_row_start + q_row < params.seq_len_q) {
                    let mask_idx = mask_global_offset + q_row * params.seq_len_kv + kv_tile + k_rel;
                    let mask_bits = bitcast<u32>(vec2<f16>(mask[mask_idx], f16(0.0))) & 0xffffu;
                    lane_visible = lane_visible || mask_bits != 0xfc00u;
                }
            }
            if (lane_visible) { atomicStore(&mask_tile_visible, 1u); }
        }
        let tile_visible = workgroupUniformLoad(&mask_tile_visible);
        if (tile_visible == 0u) { continue; }
        workgroupBarrier();
        if (local_id.x == 0u) { dst[wg_id.x] += 1u; }
        workgroupBarrier();
    }
}` });
    const info = await module.getCompilationInfo();
    result.maskSkipProbe = { messages: Array.from(info.messages, m => ({ type: m.type, line: m.lineNum, message: m.message })) };
    if (!info.messages.some(m => m.type === 'error')) {
      await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      result.maskSkipProbe.pipeline = 'created';
    }
  } catch (error) {
    result.maskSkipProbe ??= {};
    result.maskSkipProbe.error = String(error);
  } finally {
    const error = await device.popErrorScope();
    if (error) { result.maskSkipProbe ??= {}; result.maskSkipProbe.validationError = error.message; }
    device.destroy();
  }
  console.log(JSON.stringify(result, null, 2));
  return result;
})();
