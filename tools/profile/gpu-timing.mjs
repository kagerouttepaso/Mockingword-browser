// native の pipeline timestamp を step 単位で保持する。CPU待ちとは区間が重なる。
export function kernelCategory(name) {
  if (/mul_mat_vec|mmvq/i.test(name)) return 'MMVQ';
  if (/mul_mat|matmul/i.test(name)) return 'matmul';
  if (/flash_attn|attention|soft_max/i.test(name)) return 'attention';
  if (/norm/i.test(name)) return 'norm';
  if (/rope/i.test(name)) return 'rope';
  if (/copy|cpy|cont|set_rows|get_rows|memset/i.test(name)) return 'copy/rows';
  if (/quantize/i.test(name)) return 'quantize';
  return 'elementwise/other';
}
function add(target, name, value) {
  const item = target[name] ??= { ms: 0, count: 0 };
  item.ms += value.ms; item.count += value.count;
}
export function analyzeGpuEvents(events) {
  const pipelines = {}, categories = {}, steps = [];
  for (const worker of events.filter((event) => event.kind === 'worker')) {
    for (const step of worker.steps ?? []) {
      const byCategory = {}, byPipeline = step.gpu ?? {};
      let ms = 0, count = 0;
      for (const [name, value] of Object.entries(byPipeline)) {
        add(pipelines, name, value); add(categories, kernelCategory(name), value);
        add(byCategory, kernelCategory(name), value);
        ms += value.ms; count += value.count;
      }
      steps.push({ decodeStepId: step.decodeStepId, callbackId: worker.callbackId, phase: step.phase,
        tokens: step.tokens, decodeTokens: step.decodeTokens, logitsRows: step.logitsRows,
        hostMs: step.ms, queueWaitMs: step.metrics?.queueWait?.ms ?? null,
        mapWaitMs: step.metrics?.mapWait?.ms ?? null,
        status: count ? 'collected' : 'no-records', gpuTotalMs: count ? ms : null,
        gpuKernelCount: count, categories: byCategory, pipelines: byPipeline });
    }
  }
  return { status: steps.some((step) => step.status === 'collected') ? 'collected' : 'no-records',
    steps, pipelines, categories };
}

export function gpuTimingLines(timing) {
  if (!timing) return [];
  if (timing.status !== 'collected') return ['\nGPU timestamp: no-records（step 内の pipeline レコードなし）。'];
  const lines = ['\nGPU timestamp 種類別（第2回の全step合計）：', '| 種類 | GPU ms | 回数 |', '| --- | ---: | ---: |'];
  for (const [name, value] of Object.entries(timing.categories).sort((a, b) => b[1].ms - a[1].ms)) lines.push(`| ${name} | ${value.ms.toFixed(3)} | ${value.count} |`);
  lines.push('\ndecode step の出力行数別平均：', '| logits行数 | step数 | GPU ms/step | kernel数/step | host ms/step | queueWait ms/step | Map待ち ms/step |', '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  const groups = new Map();
  for (const step of timing.steps.filter((step) => step.phase === 'decode' && step.status === 'collected')) {
    const group = groups.get(step.logitsRows) ?? []; group.push(step); groups.set(step.logitsRows, group);
  }
  for (const [rows, steps] of [...groups].sort((a, b) => a[0] - b[0])) {
    const mean = (name) => (steps.reduce((sum, step) => sum + (step[name] ?? 0), 0) / steps.length).toFixed(3);
    lines.push(`| ${rows} | ${steps.length} | ${mean('gpuTotalMs')} | ${mean('gpuKernelCount')} | ${mean('hostMs')} | ${mean('queueWaitMs')} | ${mean('mapWaitMs')} |`);
  }
  lines.push('\nGPU ms は compute pass timestamp の合計。転送専用コマンドと pass 間の空白は含まない。CPU待ち区間と重なり、差引きによる待ち時間の算出には使わない。profile-gpu は pass 分割・query resolve・Map 同期を追加する。timestamp の丸めにより短い kernel は 0 ms になり得る。各stepの合計・pipeline・種類は round JSON の analysis.gpuTiming.steps に保存。');
  return lines;
}
