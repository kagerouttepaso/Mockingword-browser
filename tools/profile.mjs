// 固定ケースを前後の基準で挟み、毎回新しいBraveプロファイルで測る。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareModelCache } from './lib/model-cache.mjs';
import { PROJECT, workRoot, inside, json, hashFile, readArgs } from './wllama/support.mjs';
import { Timings } from './wllama/timing.mjs';
import { completionOptions, resolveArtifact, stageExtension, sessionOrder } from './profile/cases.mjs';
import { measureSession } from './profile/session.mjs';
import { compareSessions, formatSummary } from './profile/report.mjs';
export { stageExtension } from './profile/cases.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export async function profile(argv = process.argv.slice(2)) {
  const args = readArgs(argv, { '--work-root': 'value', '--models': 'value', '--variants': 'value', '--reference': 'value', '--candidate': 'value', '--cases': 'value', '--completion-extra': 'value', '--reference-completion-extra': 'value', '--tokens': 'flag', '--native-log': 'flag', '--parallel': 'value', '--ubatch': 'value', '--threads': 'value', '--device': 'value', '--port': 'value', '--quality-replays': 'value', '--model-cache': 'value', '--help': 'flag' });
  if (args.help) {
    console.log('node tools/profile.mjs [--models 0.8B,2B] [--variants distribution,baseline,profile | --reference baseline --candidate ARTIFACT_ID | --cases FILE] [--completion-extra JSON] [--reference-completion-extra JSON] [--tokens] [--native-log] [--work-root DIR] [--model-cache DIR] [--parallel 4] [--ubatch 512] [--device gpu|cpu] [--threads 0] [--port 9350] [--quality-replays 0]'); return;
  }
  const timer = new Timings(), root = workRoot(args['work-root']), models = (args.models ?? '0.8B,2B').split(',');
  if (models.some((model) => !['0.8B', '2B'].includes(model)) || new Set(models).size !== models.length) throw new Error('modelsが不正です');
  const config = { device: args.device ?? 'gpu', parallel: Number(args.parallel ?? 4), ubatch: Number(args.ubatch ?? 512), threads: Number(args.threads ?? 0) };
  if (!['gpu', 'cpu'].includes(config.device) || ![1, 2, 3, 4, 6, 8].includes(config.parallel) || ![128, 256, 512, 1024, 2048].includes(config.ubatch) || !Number.isInteger(config.threads) || config.threads < 0) throw new Error('計測設定が不正です');
  const port = Number(args.port ?? 9350), qualityReplayCount = Number(args['quality-replays'] ?? 0);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(qualityReplayCount) || qualityReplayCount < 0 || qualityReplayCount > 100) throw new Error('portまたはquality-replaysが不正です');
  let specifications, pairs;
  if (args.cases) { const input = JSON.parse(fs.readFileSync(args.cases, 'utf8')); specifications = input.cases; pairs = input.pairs; }
  else if (args.candidate) {
    specifications = [{ id: 'reference', artifact: args.reference ?? 'baseline', completionExtra: completionOptions(args['reference-completion-extra']) }, { id: 'candidate', artifact: args.candidate, completionExtra: completionOptions(args['completion-extra']) }];
    pairs = [{ referenceId: 'reference', candidateId: 'candidate', equivalent: false }];
  } else {
    if (args.reference || args['reference-completion-extra']) throw new Error('referenceはcandidateと組み合わせてください');
    specifications = (args.variants ?? 'distribution,baseline,profile').split(',').map((artifact) => ({ id: artifact, artifact, completionExtra: completionOptions(args['completion-extra']) }));
    pairs = specifications.some((entry) => entry.id === 'distribution') && specifications.some((entry) => entry.id === 'baseline')
      ? [{ referenceId: 'distribution', candidateId: 'baseline', equivalent: true }, ...(specifications.some((entry) => entry.id === 'profile') ? [{ referenceId: 'baseline', candidateId: 'profile', equivalent: false }] : [])]
      : specifications.slice(1).map((entry) => ({ referenceId: specifications[0].id, candidateId: entry.id, equivalent: false }));
  }
  if (!Array.isArray(specifications) || !specifications.length || specifications.some((entry) => !/^[A-Za-z0-9._-]+$/.test(entry.id)) || new Set(specifications.map((entry) => entry.id)).size !== specifications.length) throw new Error('case IDが空か重複しています');
  pairs ??= specifications.slice(1).map((entry) => ({ referenceId: specifications[0].id, candidateId: entry.id, equivalent: false }));
  const output = inside(root, path.join(root, 'profiles', String(Date.now()))); fs.mkdirSync(output, { recursive: true });
  const report = { schema: 3, status: 'running', models, config, nativeLog: !!args['native-log'], qualityReplayCount, referencePolicy: '毎回新規の前後基準。速度の過去値は再利用しない', runs: [], failedSessions: [], pairComparisons: [], pairs, outputDirectory: output };
  try {
    const snapshot = path.join(output, 'snapshot');
    await timer.phase('拡張スナップショット作成', async () => fs.cpSync(path.join(PROJECT, 'extension'), snapshot, { recursive: true }));
    const cases = await timer.phase('成果物照合・拡張コピー作成', async () => specifications.map((specification) => {
      const extra = completionOptions(specification.completionExtra ?? {}), tokens = !!args.tokens || !!specification.tokens;
      if (tokens) { extra.verbose = true; extra.return_tokens = true; }
      const info = { ...specification, nativeLog: !!args['native-log'], completionExtra: extra, tokenMode: tokens || !!extra.verbose || !!extra.return_tokens, resolved: resolveArtifact(root, specification.artifact) };
      info.extensions = {};
      for (const model of models) {
        const extension = path.join(output, 'extensions', `${info.id}-${model}`);
        stageExtension(root, snapshot, extension, info.artifact, { resolved: info.resolved, completionExtra: extra, tokens, nativeLog: info.nativeLog });
        info.extensions[model] = extension;
      }
      return info;
    }));
    for (const pair of pairs) if (!cases.some((entry) => entry.id === pair.referenceId) || !cases.some((entry) => entry.id === pair.candidateId) || pair.referenceId === pair.candidateId) throw new Error('比較するcase IDが不正です');
    report.cases = cases.map(({ id, artifact, completionExtra, tokenMode, resolved }) => ({ id, artifact, completionExtra, tokenMode, artifactId: resolved.artifact, artifactVariant: resolved.variant, inputHash: resolved.manifest?.inputHash ?? null, files: resolved.manifest?.files ?? null }));
    report.scriptHashes = {};
    report.scriptHashes['profile/browser-diagnostics.mjs'] = hashFile(path.join(HERE, 'profile/browser-diagnostics.mjs'));
    for (const file of ['profile.mjs', 'profile/cases.mjs', 'profile/session.mjs', 'profile/report.mjs', 'profile/token-hook.js', 'profile/token-utils.mjs', 'profile/background-harness.js', 'profile/offscreen-hook.js', 'lib/perf-trace.mjs', 'lib/browser.mjs', 'lib/model-cache.mjs', 'lib/model-cache-cdp.mjs']) report.scriptHashes[file] = hashFile(path.join(HERE, file));
    report.snapshotHashes = {};
    for (const file of fs.readdirSync(snapshot, { recursive: true })) if (fs.statSync(path.join(snapshot, file)).isFile()) report.snapshotHashes[file.replaceAll(path.sep, '/')] = hashFile(path.join(snapshot, file));
    const preparedModels = await timer.phase('共有モデル取得・SHA照合', () => prepareModelCache({ extension: snapshot, models, cacheRoot: args['model-cache'] }));
    report.modelCachePreparation = { cacheRoot: preparedModels.root, models: preparedModels.entries.map(({ id, url, size, sha256, hashBasis, downloadedBytes }) => ({ id, url, size, sha256, hashBasis, downloadedBytes })) };
    report.schedule = sessionOrder(cases).map((entry) => entry.id);
    for (const model of models) {
      const visits = new Map();
      for (const info of sessionOrder(cases)) {
        const visit = visits.get(info.id) ?? 0; visits.set(info.id, visit + 1);
        console.log(`計測開始: ${info.id} ${model} visit${visit}（新しいプロファイル）`);
        report.runs.push(await timer.phase(`セッション ${info.id} ${model} visit${visit}`, () => measureSession({ extension: info.extensions[model], caseInfo: info, visit, model, port, config, output, qualityReplayCount, preparedModels })));
        json(path.join(output, 'report.json'), report);
      }
    }
    report.pairComparisons = pairs.flatMap((pair) => compareSessions(report.runs, pair.referenceId, pair.candidateId, { equivalent: !!pair.equivalent }));
    report.acceptance = report.pairComparisons.map((comparison) => ({ model: comparison.model, referenceId: comparison.referenceId, candidateId: comparison.candidateId, ok: comparison.ok, adoptionAccepted: comparison.adoptionAccepted, translationMethod: comparison.translations.method }));
    report.status = report.acceptance.some((entry) => !entry.ok) ? 'review-required' : cases.some((entry) => entry.tokenMode) ? 'token-diagnostic' : 'measured';
    if (report.status === 'review-required') process.exitCode = 2;
    return report;
  } catch (e) { report.status = 'failed'; report.error = e.stack; if (e.profileSession) report.failedSessions.push(e.profileSession); throw e; }
  finally {
    report.timings = timer.snapshot(); json(path.join(output, 'report.json'), report);
    fs.writeFileSync(path.join(output, 'summary.md'), formatSummary(report));
    console.log(formatSummary(report)); console.log(`計測結果: ${output}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) profile().catch((e) => { console.error(e.stack); process.exitCode = 1; });
