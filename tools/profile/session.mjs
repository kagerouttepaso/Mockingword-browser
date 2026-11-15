import fs from 'node:fs';
import path from 'node:path';
import { launch } from '../lib/browser.mjs';
import { installModelInterception } from '../lib/model-cache-cdp.mjs';
import { analyzeEvents, summarizeRounds } from '../lib/perf-trace.mjs';
import { json } from '../wllama/support.mjs';
import { Timings } from '../wllama/timing.mjs';
import { analyzeGpuEvents } from './gpu-timing.mjs';
import { installBrowserDiagnostics } from './browser-diagnostics.mjs';

export async function measureSession({ extension, caseInfo, visit, model, port, config, output, qualityReplayCount, preparedModels }, dependencies = {}) {
  const timing = new Timings(), prefix = `${caseInfo.id}-${model}-visit${visit}`;
  const b = await timing.phase('Brave起動・拡張読込み', () => (dependencies.launch ?? launch)({ extension, port, extensionWaitMs: 0 }));
  if (b.closeFast) b.close = b.closeFast;
  const browserLog = fs.createWriteStream(path.join(output, prefix + '-browser.jsonl'));
  let result, failedSession, diagnostics;
  try {
    diagnostics = await timing.phase('Workerログ取得設定', () => installBrowserDiagnostics(b, (event) => browserLog.write(JSON.stringify(event) + '\n')));
    await timing.phase('CDPモデル供給設定', () => (dependencies.installModelInterception ?? installModelInterception)(b, { ...preparedModels, entries: preparedModels.entries.filter((entry) => entry.id === model).map((entry) => ({ ...entry, downloadedBytes: 0 })) }));
    await b.eval(b.ext, `chrome.storage.sync.set(${JSON.stringify({ model, idleMinutes: 0, debugLog: false })})`);
    await b.eval(b.ext, `chrome.storage.local.set(${JSON.stringify(config)})`);
    await b.eval(b.ext, `chrome.runtime.sendMessage({ type: 'status' })`);
    const sw = await b.waitFor(async () => (await b.targets()).find((target) => target.type === 'service_worker' && target.url.endsWith('/background/main.js')), 20000, 100);
    if (!sw) throw new Error('拡張機能の裏方が起動しませんでした');
    const session = await b.attach(sw.targetId);
    if (!await b.waitFor(() => b.eval(session, '!!globalThis.__plamoHarness'), 10000, 100)) throw new Error('計測の実行口が起動しませんでした');
    const call = (method) => b.eval(session, `globalThis.__plamoHarness.${method}()`);
    const prep = await timing.phase('モデル取得・読込み・初期生成', () => call('prepare'));
    b.modelCache.assertUsed();
    if (config.device === 'gpu' && prep.status.device !== 'gpu') throw new Error('GPU指定に対してCPUが選ばれました');
    const target = await b.waitFor(async () => (await b.targets()).find((info) => info.url.endsWith('/offscreen/offscreen.html')), 20000, 100);
    if (!target) throw new Error('offscreenが起動しませんでした');
    const off = await b.attach(target.targetId);
    const metadata = await b.eval(off, 'globalThis.__plamoProfile.metadata()');
    if (!(metadata.n_vocab > 0)) throw new Error('n_vocabを取得できませんでした');
    await timing.phase('慣らし8まとまり', () => call('round'));
    await b.eval(off, 'globalThis.__plamoProfile.reset();globalThis.__plamoTokenCollector?.reset()');
    const rounds = [], analyses = [], tokenRounds = [];
    for (let index = 0; index < 3; ++index) {
      const round = await timing.phase('計測本体', () => call('round'));
      const events = await b.eval(off, 'globalThis.__plamoProfile.drain()');
      const tokens = caseInfo.tokenMode ? await b.eval(off, 'globalThis.__plamoTokenCollector?.drain() ?? []') : [];
      const analysis = analyzeEvents(events);
      analysis.gpuTiming = analyzeGpuEvents(events);
      rounds.push(round); analyses.push(analysis); tokenRounds.push(tokens);
      json(path.join(output, `${prefix}-round${index + 1}.json`), { round, events, analysis, tokenRecords: tokens });
      console.log(`${caseInfo.id} ${model} visit${visit} ${index + 1}/3: ${(round.ms / 1000).toFixed(3)}秒`);
    }
    if (caseInfo.resolved.variant.startsWith('profile') && analyses.some((analysis) => !analysis.steps.length)) throw new Error('計測版のnative stepがありません');
    const qualityReplays = [];
    await timing.phase('訳の追加試行', async () => {
      for (let index = 0; index < qualityReplayCount; ++index) {
        qualityReplays.push(await call('round'));
        await b.eval(off, 'globalThis.__plamoProfile.reset();globalThis.__plamoTokenCollector?.reset()');
        json(path.join(output, prefix + '-quality-replays.json'), qualityReplays);
      }
    });
    const quality = await timing.phase('目印つき文章', () => call('quality'));
    result = { caseId: caseInfo.id, variant: caseInfo.id, artifact: caseInfo.resolved.artifact, artifactVariant: caseInfo.resolved.variant,
      visit, model, config, nativeLog: !!caseInfo.nativeLog, completionExtra: caseInfo.completionExtra, tokenMode: caseInfo.tokenMode, tokenRounds,
      prep, metadata, modelCache: b.modelCache.snapshot(), browser: await b.send('Browser.getVersion'), buildManifest: caseInfo.resolved.manifest,
      rounds, summary: summarizeRounds(rounds), qualityReplays, quality,
      profile: { phases: analyses.map((analysis) => analysis.phases), js: analyses.map((analysis) => analysis.js), metrics: analyses.map((analysis) => analysis.metrics), gpu: analyses.map((analysis) => analysis.gpu), gpuTiming: analyses.map((analysis) => analysis.gpuTiming), occupancy: analyses.map((analysis) => analysis.occupancy),
        decodeBreakdown: analyses.map((analysis) => analysis.decodeBreakdown),
        representativeSteps: analyses.map((analysis) => { const sorted = analysis.steps.filter((step) => step.phase === 'decode' && step.sampledTokens > 0).sort((a, b) => a.msPerSampledToken - b.msPerSampledToken); return sorted[sorted.length >> 1] ?? null; }) } };
    return result;
  } catch (error) {
    failedSession = { caseId: caseInfo.id, model, visit, nativeLog: !!caseInfo.nativeLog, error: error.stack ?? String(error) };
    error.profileSession = failedSession;
    throw error;
  } finally {
    let cleanupError;
    try { await timing.phase('後片付け', async () => {
      try { await b.close(); }
      finally {
        await diagnostics?.settle(); diagnostics?.stop();
        await new Promise((resolve) => browserLog.end(resolve));
        const snapshot = diagnostics?.snapshot() ?? { important: [], failures: [{ error: 'ログ取得設定が完了しませんでした' }] };
        json(path.join(output, prefix + '-diagnostics.json'), { caseId: caseInfo.id, model, visit, nativeLog: !!caseInfo.nativeLog, ...snapshot });
        if (result) result.diagnostics = snapshot;
        if (failedSession) failedSession.diagnostics = snapshot;
        if (b.modelCache) json(path.join(output, prefix + '-model-cache.json'), b.modelCache.snapshot());
      }
    }); } catch (error) { cleanupError = error; }
    const timings = { ...timing.snapshot(), launch: b.launchTimings };
    json(path.join(output, prefix + '-timings.json'), timings);
    if (result) result.timings = timings;
    if (failedSession) failedSession.timings = timings;
    if (cleanupError) {
      if (failedSession) {
        // GPU異常後のブラウザー終了が失敗しても、最初の例外と診断を引き継ぐ。
        failedSession.cleanupError = cleanupError.stack ?? String(cleanupError);
        failedSession.diagnostics ??= diagnostics?.snapshot();
      } else {
        cleanupError.profileSession = { caseId: caseInfo.id, model, visit, nativeLog: !!caseInfo.nativeLog,
          error: cleanupError.stack ?? String(cleanupError), diagnostics: diagnostics?.snapshot(), timings };
        throw cleanupError;
      }
    }
    if (!failedSession) b.modelCache?.assertHealthy();
  }
}
