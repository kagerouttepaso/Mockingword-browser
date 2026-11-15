// 文字列化してBraveの拡張ページへ渡す。外部の変数・モジュールを参照しない。
export async function probeMatrix(options = {}) {
  const result = { schema: 1, userAgent: navigator.userAgent, powerPreference: options.powerPreference ?? 'high-performance',
    features: [], configs: [], attempts: [], errors: [], recommendation: 'hold' };
  if (!navigator.gpu) { result.reason = 'WebGPUがありません'; return result; }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: result.powerPreference });
  if (!adapter) { result.reason = 'adapterを取得できません'; return result; }
  const info = adapter.info ?? {};
  result.adapter = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
  result.features = [...adapter.features].sort();
  result.wgslFeatures = navigator.gpu.wgslLanguageFeatures ? [...navigator.gpu.wgslLanguageFeatures].sort() : [];
  result.subgroup = { min: info.subgroupMinSize, max: info.subgroupMaxSize };
  result.configs = Array.from(info.subgroupMatrixConfigs ?? [], c => ({ componentType: c.componentType,
    resultComponentType: c.resultComponentType, M: c.M, N: c.N, K: c.K,
    minSubgroupSize: c.minSubgroupSize, maxSubgroupSize: c.maxSubgroupSize }));
  result.limits = { maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
    maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
    maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize };
  const matrix = 'chromium-experimental-subgroup-matrix';
  const requiredFeatures = ['shader-f16', 'subgroups', matrix];
  result.requiredFeatures = requiredFeatures;
  result.missingFeatures = requiredFeatures.filter(f => !adapter.features.has(f));
  if (result.missingFeatures.length) {
    result.reason = adapter.features.has('subgroup-matrix') ? '標準名だけの公開です。候補emdawnとのAPI対応を再確認します' : '必要なfeatureが普段の起動条件で公開されていません';
    return result;
  }
  const configs = result.configs.filter(c => c.componentType === 'f16' && c.resultComponentType === 'f16' &&
    [c.M, c.N, c.K].every(x => Number.isInteger(x) && x > 0 && x <= 256))
    .sort((a, b) => Number(b.M === 16 && b.N === 16 && b.K === 16) - Number(a.M === 16 && a.N === 16 && a.K === 16));
  if (!configs.length) { result.reason = '既存shaderに対応するf16入力・f16結果のconfigがありません'; return result; }
  const control = adapter.features.has('subgroup-size-control');
  result.requestedFeatures = [...requiredFeatures, ...(control ? ['subgroup-size-control'] : [])];
  let device;
  try {
    device = await adapter.requestDevice({ requiredFeatures: result.requestedFeatures });
    result.deviceCreated = true;
  } catch (error) { result.errors.push(String(error)); result.reason = 'requestDeviceが失敗しました'; return result; }
  device.addEventListener('uncapturederror', e => result.errors.push(e.error?.message ?? String(e)));
  const half = bits => {
    const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >>> 10) & 31, fraction = bits & 1023;
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * (exponent ? 1 + fraction / 1024 : fraction / 1024) * 2 ** (exponent ? exponent - 15 : -14);
  };
  try {
    for (const config of configs.slice(0, 4)) {
      const maximum = info.subgroupMaxSize;
      const minimum = config.minSubgroupSize ?? info.subgroupMinSize;
      if (!Number.isInteger(maximum) || maximum < 1 || !Number.isInteger(minimum) || minimum < 1) {
        result.reason = 'subgroupサイズが公開されていません'; return result;
      }
      // autoはadapter最大幅に合わせる。pinnedはconfigの幅に合わせて追加確認する。
      const modes = [{ name: 'auto', wg: maximum }];
      if (control) modes.push({ name: 'pinned', wg: minimum, subgroup: minimum });
      for (const mode of modes) for (const syntax of ['majorness', 'boolean']) {
        if (mode.wg > adapter.limits.maxComputeInvocationsPerWorkgroup || mode.wg > adapter.limits.maxComputeWorkgroupSizeX) continue;
        const { M, N, K } = config, elements = M * N;
        const slotCount = Math.ceil(mode.wg / Math.min(info.subgroupMinSize ?? minimum, minimum));
        const bytes = Math.ceil(elements * 2 / 4) * 4;
        const attempt = { config, mode: mode.name, workgroupSize: mode.wg, syntax, status: 'pending' };
        result.attempts.push(attempt);
        let output, readback;
        device.pushErrorScope('validation');
        try {
          const store = syntax === 'majorness' ? `subgroupMatrixStore<row_major>(&dst, sg * ${elements}u, value, ${N}u);`
            : `subgroupMatrixStore(&dst, sg * ${elements}u, value, false, ${N}u);`;
          const code = `diagnostic(off, chromium_experimental.subgroup_matrix_uniformity);
enable f16;
enable subgroups;
enable chromium_experimental_subgroup_matrix;
@group(0) @binding(0) var<storage, read_write> dst: array<f16>;
@compute @workgroup_size(${mode.wg}) ${mode.subgroup ? `@subgroup_size(${mode.subgroup})` : ''}
fn main(@builtin(subgroup_id) sg: u32) {
    let left = subgroup_matrix_left<f16, ${K}, ${M}>(f16(1.0));
    let right = subgroup_matrix_right<f16, ${N}, ${K}>(f16(1.0));
    let accumulator = subgroup_matrix_result<f16, ${N}, ${M}>(f16(0.0));
    let value = subgroupMatrixMultiplyAccumulate(left, right, accumulator);
    ${store}
}`;
          const module = device.createShaderModule({ label: `PLaMo H4b ${mode.name} ${syntax}`, code });
          const compilation = await module.getCompilationInfo();
          attempt.messages = Array.from(compilation.messages, m => ({ type: m.type, line: m.lineNum, position: m.linePos, message: m.message }));
          if (compilation.messages.some(m => m.type === 'error')) { attempt.status = 'shader-error'; continue; }
          const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
          output = device.createBuffer({ size: bytes * slotCount, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
          readback = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
          const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: output } }] });
          const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
          pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
          encoder.copyBufferToBuffer(output, 0, readback, 0, bytes); device.queue.submit([encoder.finish()]);
          let timer;
          try { await Promise.race([readback.mapAsync(GPUMapMode.READ), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('matrix読取りが15秒で完了しません')), 15000); })]); }
          finally { clearTimeout(timer); }
          const values = Array.from(new Uint16Array(readback.getMappedRange().slice(0)), half).slice(0, elements);
          readback.unmap();
          attempt.check = { count: values.length, expected: K, mismatches: values.filter(x => x !== K).length,
            nonFinite: values.filter(x => !Number.isFinite(x)).length, sample: values.slice(0, 8) };
          attempt.status = attempt.check.mismatches ? 'value-mismatch' : 'passed';
        } catch (error) { attempt.status = 'error'; attempt.error = String(error); }
        finally {
          const validation = await device.popErrorScope();
          if (validation) { attempt.validationError = validation.message; if (attempt.status === 'passed') attempt.status = 'validation-error'; }
          output?.destroy(); readback?.destroy();
        }
        if (attempt.status === 'passed') {
          result.recommendation = result.errors.length ? 'hold' : 'implementation-candidate';
          result.reason = result.errors.length ? '未捕捉エラーを確認してください' : 'feature・device要求・matrix pipeline・小行列の実行に成功しました';
          result.passed = attempt;
          result.qualityScope = '全要素1の小行列だけ。PLaMoのFP16累積品質と速度は未検証';
          return result;
        }
      }
    }
    result.reason ??= '公開されたconfigでmatrixのpipelineまたは実行が通りません';
    return result;
  } catch (error) {
    result.errors.push(String(error));
    result.reason = 'deviceの終了または診断取得に失敗しました。収集済みのattemptsを確認してください';
    return result;
  } finally { device.destroy(); }
}
