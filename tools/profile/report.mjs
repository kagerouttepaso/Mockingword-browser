import { compareTranslations } from '../lib/perf-trace.mjs';
import { compareTokenRuns } from './token-utils.mjs';
import { gpuTimingLines } from './gpu-timing.mjs';

export function compareSessions(runs, referenceId, candidateId, { equivalent = false } = {}) {
  const output = [];
  for (const model of [...new Set(runs.map((run) => run.model))]) {
    const reference = runs.filter((run) => run.caseId === referenceId && run.model === model);
    const candidate = runs.filter((run) => run.caseId === candidateId && run.model === model);
    if (!reference.length || !candidate.length) continue;
    const pool = (entries) => ({ rounds: entries.flatMap((entry) => entry.rounds), qualityReplays: entries.flatMap((entry) => entry.qualityReplays ?? []) });
    const translations = compareTranslations(pool(reference), pool(candidate));
    const speed = reference.flatMap((a) => candidate.map((b) => ({ referenceVisit: a.visit, candidateVisit: b.visit,
      referenceMs: a.summary.ms, candidateMs: b.summary.ms, delta: b.summary.ms / a.summary.ms - 1,
      tolerance: Math.max(0.05, a.summary.spread, b.summary.spread) })));
    for (const entry of speed) { entry.withinVariation = entry.candidateMs >= entry.referenceMs * (1 - entry.tolerance) && entry.candidateMs <= entry.referenceMs * (1 + entry.tolerance); entry.significantlyFaster = entry.candidateMs < entry.referenceMs * (1 - entry.tolerance); }
    const qualityMatch = [...reference, ...candidate].every((run) => run.quality.text === reference[0].quality.text && !run.quality.cut);
    const markersPreserved = [...reference, ...candidate].every((run) => /<a1>[\s\S]*<\/a1>/.test(run.quality.text) && /<a2>[\s\S]*<\/a2>/.test(run.quality.text));
    const diagnostic = [...reference, ...candidate].some((run) => run.tokenMode || run.artifactVariant.startsWith('profile'));
    const qualityAccepted = translations.accepted && qualityMatch && markersPreserved;
    const improved = speed.every((entry) => entry.significantlyFaster);
    const performanceAccepted = equivalent ? speed.every((entry) => entry.withinVariation) : improved;
    const samplingCounters = [...reference, ...candidate].filter((run) => run.profile?.metrics?.[1]?.tensorRead).map((run) => ({ caseId: run.caseId, visit: run.visit,
      tensorRead: run.profile.metrics[1].tensorRead, mapWait: run.profile.metrics[1].mapWait, hostCopy: run.profile.metrics[1].hostCopy }));
    output.push({ model, referenceId, candidateId, translations, qualityMatch, markersPreserved, qualityAccepted, speed, improved,
      diagnostic, samplingCounters, tokenComparison: compareTokenRuns(reference, candidate), performanceAccepted, adoptionAccepted: diagnostic ? null : qualityAccepted && performanceAccepted,
      ok: qualityAccepted && (diagnostic || performanceAccepted) });
  }
  return output;
}
export function gpuRows(run, index = 1) {
  return Object.entries(run.profile?.gpu?.[index] ?? {}).sort((a, b) => b[1].ms - a[1].ms);
}
export function formatDecodeBreakdown(breakdown, label) {
  if (!breakdown?.steps) return '';
  const names = [...new Set(breakdown.rows.flatMap((row) => Object.keys(row.meanComponents)))];
  const lines = [`\n${label} decodeの排他内訳（ms / step、行数=batch入力tokens）：`,
    `pure decode ${breakdown.steps} step / ${breakdown.sampledTokens} sampled token。対象外 ${breakdown.excludedSteps} step / ${breakdown.excludedSampledTokens} sampled token（phase別 ${JSON.stringify(breakdown.excludedPhases)}）。`,
    '',
    `| 行数 | step数 | sampled token数 | decode時間比 | step ms | ${names.join(' | ')} | 説明済 ms | 説明率 | 未説明 ms |`,
    `| ---: | ---: | ---: | ---: | ---: | ${names.map(() => '---:').join(' | ')} | ---: | ---: | ---: |`];
  const number = (value) => value == null ? '取得不能' : value.toFixed(3);
  for (const row of breakdown.rows) lines.push(`| ${row.rows} | ${row.steps} | ${row.sampledTokens} | ${number(row.decodeTimePercent)}% | ${number(row.meanStepMs)} | ${names.map((name) => number(row.meanComponents[name] ?? 0)).join(' | ')} | ${number(row.meanExplainedMs)} | ${number(row.explanationPercent)}% | ${number(row.meanUnexplainedMs)} |`);
  if (breakdown.rows.some((row) => row.modes['outer-scopes'])) {
    lines.push('\n既存JSONの粗い排他木は step → wasmDecode / sampling。両者はserverの別Scopeで順に実行され、下位のbuild・read・API待機時間を包含する。説明率は両Scopeの合計 / step時間、未説明はその外側のstep自己時間。各行は時間合計から計算する。',
      '細分化は親ごとの計測が必要：bindGroup・writeBufferはbuild内外、submitはtensorRead内外で同じcounterへ集約される。mapWaitの呼出し元も保存されず、既存counterから各親の自己時間を一意に復元できない。下表の包含値は排他内訳へ加算しない。',
      '', '| 行数 | queueWait ms | webgpuBuild ms | tensorRead ms |', '| ---: | ---: | ---: | ---: |');
    for (const row of breakdown.rows) lines.push(`| ${row.rows} | ${number(row.meanInclusive.queueWait)} | ${number(row.meanInclusive.webgpuBuild)} | ${number(row.meanInclusive.tensorRead)} |`);
  }
  if (breakdown.rows.some((row) => row.modes['self-ms'])) lines.push('\nselfMsを持つ計測は、各Scopeの子区間を除いた自己時間を項目ごとに合計する。葉と親の自己時間が排他的に並ぶ。');
  if (breakdown.rows.some((row) => row.modes['scope-tree'])) {
    lines.push('\nscopeTreeの各nodeのselfMsを8区分へ集約する。llamaGraph=llamaの計算グラフ構築、backendScheduler=ggmlの割当・実行スケジューラー、webgpuPrepare=bind group・引数・encoderの準備、submit=キュー投入、gpuWait=GPU完了待ち、readback=Map・コピーを含む読戻し、sampling=採択処理、otherWasm=外側decodeとstepの自己時間。Mapに含まれるGPU待ちはreadbackへ分類する。未説明は木のselfMs合計とstep実時間との差であり、otherWasmは上表で独立して残す。',
      '', '| 行数 | otherWasm比 | 未説明5%未満・木の整合 |', '| ---: | ---: | --- |');
    for (const row of breakdown.rows) lines.push(`| ${row.rows} | ${number(row.otherWasmPercent)}% | ${row.unexplainedUnderFivePercent ? '合格' : '要確認'} |`);
  }
  const issues = breakdown.rows.flatMap((row) => row.issues);
  if (issues.length) lines.push(`\n計測の不整合 ${issues.length} 件：${JSON.stringify(issues)}。負値は補正せず表示する。`);
  return lines.join('\n') + '\n';
}
export function formatSummary(report) {
  const lines = ['| case | artifact | モデル | visit | 語彙数 | 中央値 秒 | 最初 秒 | tokens/s | ばらつき |', '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const run of report.runs) lines.push(`| ${run.caseId ?? run.variant} | ${run.artifact ?? run.variant} | ${run.model} | ${run.visit ?? 0} | ${run.metadata.n_vocab} | ${(run.summary.ms / 1000).toFixed(3)} | ${(run.summary.firstMs / 1000).toFixed(3)} | ${run.summary.tokenFallback ? '取得不能' : run.summary.tps.toFixed(1)} | ${(100 * run.summary.spread).toFixed(1)}% |`);
  for (const comparison of report.pairComparisons ?? []) {
    lines.push(`\n${comparison.model} ${comparison.referenceId} / ${comparison.candidateId}: 訳 ${comparison.translations.method}、マーカー ${comparison.markersPreserved}、速度採否 ${comparison.adoptionAccepted ?? '診断用'}。`);
    for (const speed of comparison.speed) lines.push(`基準visit${speed.referenceVisit} / 候補visit${speed.candidateVisit}: ${(100 * speed.delta).toFixed(1)}%（判定幅 ${(100 * speed.tolerance).toFixed(1)}%）。`);
    for (const difference of comparison.translations.differences) for (const line of difference.lines) lines.push(`バッチ${difference.paragraph}・${line.line}行目：${line.reference} → ${line.candidate}（基準で観測 ${difference.observedInReference}）。`);
    if (comparison.tokenComparison) lines.push(`token列の診断: 基準 ${comparison.tokenComparison.referenceRecords} 件、候補 ${comparison.tokenComparison.candidateRecords} 件、列なし ${comparison.tokenComparison.unavailable} 件、usage数との差 ${comparison.tokenComparison.countDifferences} 件、基準未観測 ${comparison.tokenComparison.novel.length} 件。速度採否には使わない。`);
    if (comparison.samplingCounters?.length) {
      lines.push('\n第2回のsampling関連の読取り：', '| case / visit | tensorRead 回数 / ms | mapWait 回数 / ms | hostCopy bytes |', '| --- | ---: | ---: | ---: |');
      for (const row of comparison.samplingCounters) lines.push(`| ${row.caseId} / ${row.visit} | ${row.tensorRead.count} / ${row.tensorRead.ms.toFixed(3)} | ${row.mapWait.count} / ${row.mapWait.ms.toFixed(3)} | ${row.hostCopy.bytes} |`);
    }
  }
  for (const run of report.runs.filter((entry) => entry.profile?.metrics?.[1] && Object.keys(entry.profile.metrics[1]).length)) {
    lines.push(`\n${run.caseId ?? run.variant} ${run.model} visit${run.visit ?? 0} 第2回の内訳（包含関係あり）：`, '| 項目 | ms | 回数 | bytes |', '| --- | ---: | ---: | ---: |');
    for (const [name, value] of Object.entries(run.profile.metrics[1])) lines.push(`| ${name} | ${value.ms.toFixed(3)} | ${value.count} | ${value.bytes} |`);
    const gpu = gpuRows(run);
    lines.push(...gpuTimingLines(run.profile.gpuTiming?.[1]));
    if (gpu.length) {
      lines.push('\nGPU timestamp（kernel別。通常速度の採否とは別の実行）：', '| pipeline | ms | 回数 |', '| --- | ---: | ---: |');
      for (const [name, value] of gpu) lines.push(`| ${name.replaceAll('|', '\\|')} | ${value.ms.toFixed(3)} | ${value.count} |`);
    } else if ((run.artifactVariant ?? run.variant).startsWith('profile-gpu')) lines.push('\nGPU timestamp: unavailable（native timestampレコードなし。ビルド指定・機能対応・収集経路を確認する）。');
    const step = run.profile.representativeSteps?.[1];
    if (step) lines.push(`\n代表step ${step.decodeStepId}: ${step.sampledTokens} token、${step.logitsRows} logits行、${step.ms.toFixed(3)} ms / step、${step.msPerSampledToken.toFixed(3)} ms / token。`);
    const occupancy = run.profile.occupancy?.[1];
    if (occupancy?.busySteps) lines.push(`decodeを含む ${occupancy.busySteps} step / ${occupancy.sampledTokens} token（平均 ${occupancy.meanTokensPerBusyStep.toFixed(2)} 本）。decodeなし ${occupancy.idleSteps} loop。本数別step ${JSON.stringify(occupancy.histogram)}。`);
  }
  for (const run of report.runs) for (const [index, breakdown] of (run.profile?.decodeBreakdown ?? []).entries()) {
    const table = formatDecodeBreakdown(breakdown, `${run.caseId ?? run.variant} ${run.model} visit${run.visit ?? 0} 第${index + 1}回`);
    if (table) lines.push(table);
  }
  if (report.timings) {
    lines.push('\nセットアップと計測の経過時間（工程は親子で重なる）：', '| 工程 | 秒 |', '| --- | ---: |');
    for (const row of report.timings.phases) lines.push(`| ${row.name} | ${(row.ms / 1000).toFixed(3)} |`);
    lines.push(`全体 ${(report.timings.totalMs / 1000).toFixed(3)} 秒。`);
  }
  for (const run of report.runs.filter((entry) => entry.timings)) {
    lines.push(`\n${run.caseId} ${run.model} visit${run.visit} の工程：`, '| 工程 | 秒 |', '| --- | ---: |');
    for (const row of run.timings.phases) lines.push(`| ${row.name} | ${(row.ms / 1000).toFixed(3)} |`);
    if (run.timings.launch) lines.push(`Brave接続 ${(run.timings.launch.browserMs / 1000).toFixed(3)} 秒、拡張準備 ${(run.timings.launch.extensionMs / 1000).toFixed(3)} 秒。`);
    if (run.metadata.load) lines.push(`モデルURL読込み ${(run.metadata.load.totalMs / 1000).toFixed(3)} 秒、native読込み ${run.metadata.load.nativeLoadMs == null ? '取得不能' : (run.metadata.load.nativeLoadMs / 1000).toFixed(3) + ' 秒'}。`);
  }
  const diagnosticSessions = [...report.runs, ...(report.failedSessions ?? [])];
  const errors = diagnosticSessions.flatMap((run) => (run.diagnostics?.important ?? []).map((entry) => ({ run, ...entry }))).slice(0, 10);
  if (report.error) lines.push(`\n計測停止：${report.error.split('\n')[0]}`);
  if (errors.length) {
    const cell = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
    lines.push('\nブラウザー診断：error・warnまたはggml / WebGPU / WGSLを含む先頭10件。全文とCDP引数はbrowser.jsonlに保存。',
      '', '| case / model / visit | level | target | 本文 |', '| --- | --- | --- | --- |');
    for (const entry of errors) lines.push(`| ${cell(entry.run.caseId ?? entry.run.variant)} / ${cell(entry.run.model)} / ${entry.run.visit ?? 0} | ${cell(entry.level)} | ${cell(entry.target?.type)} ${cell(entry.target?.url)} | ${cell(entry.text)} |`);
  }
  for (const run of diagnosticSessions) for (const failure of run.diagnostics?.failures ?? []) lines.push(`\nログ取得設定の失敗：${run.caseId ?? run.variant} ${failure.target?.type ?? ''} ${failure.error}`);
  return lines.join('\n') + '\n';
}
