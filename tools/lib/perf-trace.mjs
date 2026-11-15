// 時間には包含関係がある。経過時間・呼出し回数・バイトを保ち、重なる区間を加算して割合にしない。
export const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
export function summarizeRounds(rounds) {
  const ms = median(rounds.map((r) => r.ms));
  return { ms, firstMs: median(rounds.map((r) => r.firstMs)), tokens: median(rounds.map((r) => r.tokens)),
    spread: (Math.max(...rounds.map((r) => r.ms)) - Math.min(...rounds.map((r) => r.ms))) / ms,
    tps: median(rounds.map((r) => r.tokens)) * 1000 / ms, tokenFallback: rounds.some((r) => r.tokenFallback) };
}
export function stepOccupancy(steps) {
  const busy = steps.filter((step) => step.metrics.wasmDecode?.count > 0), histogram = {}, spans = new Map();
  for (const step of busy) {
    histogram[step.sampledTokens] = (histogram[step.sampledTokens] ?? 0) + 1;
    for (const sequence of step.sequences) {
      const span = spans.get(sequence.requestId) ?? { requestId: sequence.requestId, firstStep: step.decodeStepId, lastStep: step.decodeStepId, steps: 0 };
      span.lastStep = step.decodeStepId; span.steps++; spans.set(sequence.requestId, span);
    }
  }
  const sampledTokens = busy.reduce((sum, step) => sum + step.sampledTokens, 0);
  const continuousActiveMatch = busy.filter((step) => [...spans.values()].filter((span) => span.firstStep <= step.decodeStepId && span.lastStep >= step.decodeStepId).length === step.sequences.length).length;
  return { busySteps: busy.length, idleSteps: steps.length - busy.length, sampledTokens, meanTokensPerBusyStep: busy.length ? sampledTokens / busy.length : null,
    histogram, continuousActiveMatch, nativeRequestSpans: [...spans.values()] };
}
// 計測パッチの Scope は inclusive の合計のみを保存する。同じ metric が複数の
// 親から呼ばれるため、名前だけで子の全時間を一つの親から差し引いてはいけない。
// sources は tools/wllama/patches/profile/0001-host-timeline.patch の関数名。
// parents は取り得る計測済み祖先（未計測の関数を省略）であり、復元済みの木ではない。
export const metricContexts = {
  step: { sources: ['wllama_context::run_loop', 'plamo_profile::begin_step/end_step'], parents: [] },
  wasmDecode: { sources: ['server-context.cpp: queue_tasks.yield_to_queue (llama_process + llama_synchronize)'], parents: ['step'] },
  sampling: { sources: ['server-context.cpp: common_sampler_sample'], parents: ['step'] },
  llamaGraph: { sources: ['llama_context::process_ubatch', 'llama_context::graph_reserve', 'llama_context::opt_epoch_iter: model.build_graph'], parents: ['wasmDecode'] },
  backendScheduler: { sources: ['ggml_backend_sched_alloc_graph', 'ggml_backend_sched_graph_compute_async'], parents: ['wasmDecode'] },
  webgpuBuild: { sources: ['ggml_backend_webgpu_build_multi'], parents: ['wasmDecode'] },
  bindGroup: { sources: ['ggml_backend_webgpu_build_multi', 'ggml_backend_webgpu_buffer_memset', 'ggml_backend_webgpu_buffer_set_tensor_n'], parents: ['webgpuBuild', 'wasmDecode'] },
  writeBuffer: { sources: ['ggml_backend_webgpu_build_multi', 'ggml_backend_webgpu_buffer_memset', 'ggml_backend_webgpu_set_tensor_async', 'ggml_backend_webgpu_buffer_set_tensor', 'ggml_backend_webgpu_buffer_set_tensor_n'], parents: ['webgpuBuild', 'wasmDecode'] },
  tensorRead: { sources: ['ggml_backend_webgpu_buffer_get_tensor', 'ggml_backend_webgpu_buffer_get_tensor_n'], parents: ['wasmDecode', 'sampling'] },
  submit: { sources: ['ggml_backend_webgpu_submit_commands', 'ggml_backend_webgpu_debug', 'ggml_backend_webgpu_buffer_memset', 'ggml_backend_webgpu_buffer_set_tensor_n', 'ggml_backend_webgpu_buffer_get_tensor', 'ggml_backend_webgpu_buffer_get_tensor_n'], parents: ['wasmDecode', 'tensorRead'] },
  queueWait: { sources: ['ggml_backend_webgpu_wait_queue'], parents: ['wasmDecode'], unresolvedCaller: true },
  mapWait: { sources: ['ggml_backend_webgpu_map_buffer'], parents: ['tensorRead', 'wasmDecode'], unresolvedCaller: true },
  hostCopy: { sources: ['ggml_backend_webgpu_buffer_get_tensor', 'ggml_backend_webgpu_buffer_get_tensor_n: memcpy'], parents: ['tensorRead'] },
  eventWait: { sources: ['ggml_backend_webgpu_device_event_synchronize'], parents: ['wasmDecode'], unresolvedCaller: true },
};

// 既存JSONで復元可能な木。decodeとsamplingのScopeはserver側で順に終了する。
// 下位区間のinclusive値はここへ足さず、それぞれの葉に包含したまま保つ。
export const resolvedMetricTree = { name: 'step', children: [{ name: 'wasmDecode' }, { name: 'sampling' }] };

export const cpuCategories = ['llamaGraph', 'backendScheduler', 'webgpuPrepare', 'submit', 'gpuWait', 'readback', 'sampling', 'otherWasm'];
const cpuCategory = { step: 'otherWasm', wasmDecode: 'otherWasm', llamaGraph: 'llamaGraph', backendScheduler: 'backendScheduler',
  webgpuBuild: 'webgpuPrepare', bindGroup: 'webgpuPrepare', writeBuffer: 'webgpuPrepare', submit: 'submit',
  queueWait: 'gpuWait', eventWait: 'gpuWait', tensorRead: 'readback', mapWait: 'readback', hostCopy: 'readback', sampling: 'sampling' };

// 記録された親経路の木を検証する。子のinclusive合計＋親self＝親inclusiveを照合し、
// 同じmetricが異なる親や再帰的な同一metric配下にある場合も、各nodeのselfだけを数える。
export function scopeTreeBreakdown(step) {
  const nodes = step.scopeTree;
  const byId = new Map(), issues = [], components = Object.fromEntries(cpuCategories.map((name) => [name, 0]));
  const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  for (const node of nodes) {
    if (byId.has(node.id)) issues.push(`duplicate-node:${node.id}`);
    byId.set(node.id, node);
    if (!Number.isFinite(node.ms) || !Number.isFinite(node.selfMs)) issues.push(`invalid-time:${node.id}`);
    if (node.selfMs < 0) issues.push(`negative:${node.id}`);
    const category = cpuCategory[node.metric];
    if (category) components[category] += node.selfMs;
    else issues.push(`unknown-metric:${node.metric}`);
  }
  const roots = nodes.filter((node) => node.parentId === null);
  if (roots.length !== 1 || roots[0]?.metric !== 'step') issues.push('invalid-root');
  if (!close(roots[0]?.ms, step.ms)) issues.push('root-step-mismatch');
  const childMs = new Map();
  for (const node of nodes) if (node.parentId !== null) {
    if (!byId.has(node.parentId)) issues.push(`missing-parent:${node.id}`);
    childMs.set(node.parentId, (childMs.get(node.parentId) ?? 0) + node.ms);
    const visited = new Set([node.id]); let parent = node.parentId;
    while (parent !== null && byId.has(parent)) {
      if (visited.has(parent)) { issues.push(`cycle:${node.id}`); break; }
      visited.add(parent); parent = byId.get(parent).parentId;
    }
  }
  for (const node of nodes) if (!close(node.ms, node.selfMs + (childMs.get(node.id) ?? 0))) issues.push(`node-balance:${node.id}`);
  for (const [name, counter] of Object.entries(step.metrics ?? {})) {
    const matching = nodes.filter((node) => node.metric === name);
    if (!close(counter.selfMs, matching.reduce((sum, node) => sum + node.selfMs, 0))) issues.push(`counter-self-mismatch:${name}`);
    if (!close(counter.ms, matching.reduce((sum, node) => sum + node.ms, 0))) issues.push(`counter-inclusive-mismatch:${name}`);
    if (counter.count !== matching.reduce((sum, node) => sum + node.count, 0)) issues.push(`counter-count-mismatch:${name}`);
    if (counter.bytes !== matching.reduce((sum, node) => sum + node.bytes, 0)) issues.push(`counter-bytes-mismatch:${name}`);
  }
  const explainedMs = Object.values(components).reduce((sum, ms) => sum + ms, 0);
  return { mode: 'scope-tree', components, explainedMs, unexplainedMs: step.ms - explainedMs,
    explanationPercent: step.ms > 0 ? 100 * explainedMs / step.ms : null, unresolvedMetrics: [], issues,
    otherWasmPercent: step.ms > 0 ? 100 * components.otherWasm / step.ms : null };
}

export function exclusiveStepBreakdown(step) {
  if (Array.isArray(step.scopeTree)) return scopeTreeBreakdown(step);
  const metrics = step.metrics ?? {};
  const active = Object.entries(metrics).filter(([, counter]) => counter.count > 0 || counter.ms !== 0);
  const hasSelfTimes = active.length > 0 && active.every(([, counter]) => Number.isFinite(counter.selfMs));
  const missingOuter = ['wasmDecode', 'sampling'].filter((name) => !Number.isFinite(metrics[name]?.ms));
  const mode = hasSelfTimes ? 'self-ms' : missingOuter.length ? 'unavailable' : 'outer-scopes';
  const components = mode === 'self-ms' ? Object.fromEntries(active.map(([name, counter]) => [name, counter.selfMs]))
    : mode === 'outer-scopes' ? { wasmDecode: metrics.wasmDecode.ms, sampling: metrics.sampling.ms } : {};
  const explainedMs = Object.values(components).reduce((sum, ms) => sum + ms, 0);
  // 負値は計測の矛盾として残す。丸めやclampで説明率を100%へ合わせない。
  const unexplainedMs = step.ms - explainedMs;
  const issues = [
    ...missingOuter.filter(() => mode !== 'self-ms').map((name) => `missing:${name}`),
    ...Object.entries(components).filter(([, ms]) => ms < 0).map(([name]) => `negative:${name}`),
    ...active.filter(([name, counter]) => mode === 'self-ms' && counter.selfMs > counter.ms).map(([name]) => `self-exceeds-inclusive:${name}`),
    ...(unexplainedMs < -1e-6 ? ['explained-exceeds-step'] : []),
  ];
  return { mode, components, explainedMs, unexplainedMs, explanationPercent: step.ms > 0 ? 100 * explainedMs / step.ms : null,
    unresolvedMetrics: mode === 'self-ms' ? [] : active.map(([name]) => name).filter((name) => !Object.hasOwn(components, name)), issues };
}

export function decodeStepBreakdown(steps) {
  // 行数はpure decodeのbatch入力tokens。sampling回数やlogitsRowsはEOS・実装で異なる。
  const selected = steps.filter((step) => step.phase === 'decode' && step.metrics?.wasmDecode?.count > 0);
  const groups = new Map();
  for (const step of selected) {
    const row = groups.get(step.tokens) ?? { rows: step.tokens, steps: 0, sampledTokens: 0, stepMs: 0,
      explainedMs: 0, unexplainedMs: 0, components: {}, inclusive: {}, modes: {}, issues: [], unresolvedMetrics: new Set() };
    const breakdown = exclusiveStepBreakdown(step);
    row.steps++; row.sampledTokens += step.sampledTokens ?? step.metrics.sampling?.count ?? 0; row.stepMs += step.ms;
    row.explainedMs += breakdown.explainedMs; row.unexplainedMs += breakdown.unexplainedMs;
    row.modes[breakdown.mode] = (row.modes[breakdown.mode] ?? 0) + 1;
    for (const [name, ms] of Object.entries(breakdown.components)) row.components[name] = (row.components[name] ?? 0) + ms;
    for (const [name, counter] of Object.entries(step.metrics)) row.inclusive[name] = (row.inclusive[name] ?? 0) + counter.ms;
    for (const name of breakdown.unresolvedMetrics) row.unresolvedMetrics.add(name);
    for (const issue of breakdown.issues) row.issues.push({ decodeStepId: step.decodeStepId, issue });
    groups.set(step.tokens, row);
  }
  const totalMs = selected.reduce((sum, step) => sum + step.ms, 0);
  const excluded = steps.filter((step) => !(step.phase === 'decode' && step.metrics?.wasmDecode?.count > 0));
  return { definition: 'pure decode / batch input tokens / weighted duration coverage',
    tree: selected.some((step) => Array.isArray(step.scopeTree)) ? { source: 'steps.scopeTree', kind: 'parent-path' } : resolvedMetricTree,
    steps: selected.length, stepMs: totalMs, sampledTokens: selected.reduce((sum, step) => sum + (step.sampledTokens ?? step.metrics.sampling?.count ?? 0), 0),
    excludedSteps: excluded.length, excludedSampledTokens: excluded.reduce((sum, step) => sum + (step.sampledTokens ?? step.metrics?.sampling?.count ?? 0), 0),
    excludedPhases: Object.fromEntries([...new Set(excluded.map((step) => step.phase))].map((phase) => [phase, excluded.filter((step) => step.phase === phase).length])),
    rows: [...groups.values()].sort((a, b) => a.rows - b.rows).map((row) => ({ ...row,
      unresolvedMetrics: [...row.unresolvedMetrics], meanStepMs: row.stepMs / row.steps,
      meanComponents: Object.fromEntries(Object.entries(row.components).map(([name, ms]) => [name, ms / row.steps])),
      meanInclusive: Object.fromEntries(Object.entries(row.inclusive).map(([name, ms]) => [name, ms / row.steps])),
      meanExplainedMs: row.explainedMs / row.steps, meanUnexplainedMs: row.unexplainedMs / row.steps,
      explanationPercent: row.stepMs > 0 ? 100 * row.explainedMs / row.stepMs : null,
      otherWasmPercent: row.stepMs > 0 && Object.hasOwn(row.components, 'otherWasm') ? 100 * row.components.otherWasm / row.stepMs : null,
      unexplainedUnderFivePercent: row.stepMs > 0 && row.issues.length === 0 && Math.abs(row.unexplainedMs) / row.stepMs < 0.05,
      decodeTimePercent: totalMs > 0 ? 100 * row.stepMs / totalMs : null })) };
}
function totalMetrics(steps) {
  const result = {};
  for (const step of steps) for (const [name, counter] of Object.entries(step.metrics)) {
    const entry = result[name] ??= { count: 0, ms: 0, bytes: 0 };
    entry.count += counter.count; entry.ms += counter.ms; entry.bytes += counter.bytes;
  }
  return result;
}
export function analyzeEvents(events) {
  const actions = new Map(events.filter((e) => e.kind === 'action').map((e) => [e.callbackId, e]));
  const workers = events.filter((e) => e.kind === 'worker');
  const steps = workers.flatMap((worker) => worker.steps.map((step) => ({ ...step, callbackId: worker.callbackId,
    actionTiming: { workerMs: worker.workerMs, sharedBySteps: worker.steps.length,
      encodeMs: actions.get(worker.callbackId)?.encodeMs ?? null, glueMs: actions.get(worker.callbackId)?.glueMs ?? null,
      rttMs: actions.get(worker.callbackId)?.rttMs ?? null,
      roundTripOutsideWorkerMs: actions.has(worker.callbackId) ? Math.max(0, actions.get(worker.callbackId).rttMs - worker.workerMs) : null },
    polledRequestId: actions.get(worker.callbackId)?.requestId ?? null,
    sampledTokens: step.metrics.sampling.count,
    msPerSampledToken: step.metrics.sampling.count ? step.ms / step.metrics.sampling.count : null })));
  const phases = {};
  for (const phase of ['prefill', 'decode', 'mixed', 'idle']) {
    const selected = steps.filter((s) => s.phase === phase);
    phases[phase] = { steps: selected.length, loopMs: selected.reduce((sum, s) => sum + s.ms, 0),
      inputTokens: selected.reduce((sum, s) => sum + s.tokens, 0), sampledTokens: selected.reduce((sum, s) => sum + s.sampledTokens, 0),
      logitsRows: selected.reduce((sum, s) => sum + s.logitsRows, 0), logitsBytes: selected.reduce((sum, s) => sum + s.logitsBytes, 0), metrics: totalMetrics(selected) };
  }
  const js = { calls: actions.size, emptyPolls: 0, encodeMs: 0, glueMs: 0, workerMs: 0, rttMs: 0, roundTripOutsideWorkerMs: 0 };
  const workerById = new Map(workers.map((w) => [w.callbackId, w]));
  for (const action of actions.values()) {
    js.emptyPolls += action.empty ? 1 : 0;
    js.encodeMs += action.encodeMs; js.glueMs += action.glueMs; js.rttMs += action.rttMs;
    const workerMs = workerById.get(action.callbackId)?.workerMs ?? 0;
    js.workerMs += workerMs;
    // 同時要求のキュー待ちも含む。並列要求の値を wall time と比較しない。
    js.roundTripOutsideWorkerMs += Math.max(0, action.rttMs - workerMs);
  }
  const gpu = {};
  for (const step of steps) for (const [name, value] of Object.entries(step.gpu ?? {})) {
    const entry = gpu[name] ??= { count: 0, ms: 0 };
    entry.count += value.count; entry.ms += value.ms;
  }
  return { steps, phases, js, gpu, metrics: totalMetrics(steps), occupancy: stepOccupancy(steps), decodeBreakdown: decodeStepBreakdown(steps),
    notes: ['metrics の ms は包含関係のある経過時間。webgpuBuild は bindGroup と writeBuffer を含む。',
      'queueWait・Map 待ちは GPU 実行と通知を含む。tensorRead はその Map 待ちを含む。sampling も遅延同期を含み得る。',
      'JS 往復は Worker 入口の外側と要求キュー待ちを含む。並列要求どうしの区間は重なる。',
      'phase は server_batch::token.is_prompt から判定する。prefill と decode が同じ step に入ったものは mixed。',
      'step は run_loop 1回。decodeStepId と実際の wasmDecode.count を併記する。idle の空 poll も残す。',
      'sampledTokens は EOS を含む sampler 呼出し数。usage.completion_tokens と区別する。'] };
}
function translationObservations(run) {
  return [
    ...run.rounds.map((round, index) => ({ label: `round${index + 1}`, results: round.results })),
    ...(run.qualityReplays ?? []).map((round, index) => ({ label: `replay${index + 1}`, results: round.results })),
  ];
}
function translationVariation(observations, paragraphCount) {
  const first = observations[0]?.results;
  const valid = observations.length > 0 && observations.every((observation) => observation.results?.length === paragraphCount
    && observation.results.every((result) => typeof result.text === 'string'));
  const paragraphs = Array.from({ length: paragraphCount }, (_, index) => {
    const variants = new Map();
    for (const observation of observations) {
      const result = observation.results[index];
      if (!result) continue;
      const variant = variants.get(result.text) ?? { text: result.text, observations: [], tokenCounts: [], cutStates: [] };
      variant.observations.push(observation.label);
      if (!variant.tokenCounts.includes(result.tokens)) variant.tokenCounts.push(result.tokens);
      if (!variant.cutStates.includes(!!result.cut)) variant.cutStates.push(!!result.cut);
      variants.set(result.text, variant);
    }
    return { paragraph: index + 1, variants: [...variants.values()] };
  });
  const changedParagraphs = observations.map((observation) => ({ observation: observation.label,
    count: valid ? observation.results.filter((result, index) => result.text !== first[index].text).length : null }));
  return { valid, observations: observations.length, paragraphs, changedParagraphs,
    textsMatch: valid && paragraphs.every((paragraph) => paragraph.variants.length === 1),
    noCuts: valid && observations.every((observation) => observation.results.every((result) => !result.cut)),
    maxChangedParagraphs: valid ? Math.max(...changedParagraphs.map((item) => item.count)) : null };
}
export function compareTranslations(referenceRun, candidateRun) {
  const reference = translationObservations(referenceRun), candidate = translationObservations(candidateRun);
  const paragraphCount = reference[0]?.results.length ?? 0;
  const referenceVariation = translationVariation(reference, paragraphCount);
  const candidateVariation = translationVariation(candidate, paragraphCount);
  const first = reference[0]?.results ?? [];
  const differences = [];
  for (const observation of candidate) for (let index = 0; index < Math.max(paragraphCount, observation.results.length); ++index) {
    const expected = first[index], actual = observation.results[index];
    if (expected?.text === actual?.text) continue;
    const expectedLines = (expected?.text ?? '').split('\n'), actualLines = (actual?.text ?? '').split('\n');
    differences.push({ observation: observation.label, paragraph: index + 1, referenceText: expected?.text ?? null,
      candidateText: actual?.text ?? null, referenceTokens: expected?.tokens ?? null, candidateTokens: actual?.tokens ?? null,
      lines: Array.from({ length: Math.max(expectedLines.length, actualLines.length) }, (_, line) => ({ line: line + 1,
        reference: expectedLines[line] ?? null, candidate: actualLines[line] ?? null })).filter((line) => line.reference !== line.candidate),
      observedInReference: referenceVariation.paragraphs[index]?.variants.some((variant) => variant.text === actual?.text) ?? false });
  }
  const valid = paragraphCount > 0 && referenceVariation.valid && candidateVariation.valid;
  const noCuts = valid && referenceVariation.noCuts && candidateVariation.noCuts;
  const textsMatch = valid && referenceVariation.textsMatch && candidateVariation.textsMatch && differences.length === 0;
  // 候補だけの揺れを許容しない。基準版で実際に得た訳の集合と、1回あたりの変動量で確認する。
  const candidateMaxChanged = valid ? Math.max(...candidate.map((observation) => observation.results.filter((result, index) => result.text !== first[index].text).length)) : null;
  const matchesObservedReferenceVariation = noCuts && !referenceVariation.textsMatch
    && differences.every((difference) => difference.observedInReference)
    && candidateMaxChanged <= referenceVariation.maxChangedParagraphs;
  return { textsMatch, noCuts, referenceVariation, candidateVariation, differences,
    candidateMaxChangedParagraphs: candidateMaxChanged, matchesObservedReferenceVariation,
    tokenCountsMatch: valid && [...reference, ...candidate].every((observation) => observation.results.every((result, index) => result.tokens === first[index].tokens)),
    cutStatesMatch: valid && [...reference, ...candidate].every((observation) => observation.results.every((result, index) => !!result.cut === !!first[index].cut)),
    accepted: noCuts && (textsMatch || matchesObservedReferenceVariation),
    method: noCuts && textsMatch ? 'exact' : matchesObservedReferenceVariation ? 'observed-reference-variation' : 'review-required' };
}
export function compareRuns(runs) {
  const comparisons = [];
  for (const model of [...new Set(runs.map((r) => r.model))]) {
    const byVariant = Object.fromEntries(runs.filter((r) => r.model === model).map((r) => [r.variant, r]));
    const dist = byVariant.distribution, base = byVariant.baseline, profile = byVariant.profile;
    const compare = (a, b) => {
      const delta = b.summary.ms / a.summary.ms - 1;
      const tolerance = Math.max(0.05, a.summary.spread, b.summary.spread);
      const translations = compareTranslations(a, b);
      return { delta, tolerance, withinVariation: Math.abs(delta) <= tolerance,
        translationsMatch: translations.textsMatch, translationsAccepted: translations.accepted, translations,
        qualityMatch: b.quality.text === a.quality.text && !a.quality.cut && !b.quality.cut,
        markersPreserved: /<a1>[^]*<\/a1>/.test(b.quality.text) && /<a2>[^]*<\/a2>/.test(b.quality.text) };
    };
    comparisons.push({ model, baselineVsDistribution: dist && base ? compare(dist, base) : null,
      profileOverhead: base && profile ? compare(base, profile) : null });
  }
  return comparisons;
}
export function acceptanceForComparisons(comparisons) {
  return comparisons.flatMap((comparison) => {
    const checks = [];
    for (const [key, check, requireSpeed] of [['baselineVsDistribution', 'baseline', true], ['profileOverhead', 'profileQuality', false]]) {
      const value = comparison[key];
      if (value) checks.push({ model: comparison.model, check,
        translationMethod: value.translations.method,
        ok: (!requireSpeed || value.withinVariation) && value.translationsAccepted && value.qualityMatch && value.markersPreserved });
    }
    return checks;
  });
}
