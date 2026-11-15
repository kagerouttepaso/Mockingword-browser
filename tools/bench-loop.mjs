// 候補をビルドし、固定した成果物を基準で前後から挟んで測る。採否と1周の時間を保存する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './wllama/build.mjs';
import { profile } from './profile.mjs';
import { workRoot, inside, json, readArgs } from './wllama/support.mjs';
import { Timings } from './wllama/timing.mjs';
import { resolveArtifact, completionOptions } from './profile/cases.mjs';

export async function benchLoop(argv = process.argv.slice(2)) {
  const args = readArgs(argv, { '--candidate': 'value', '--reference': 'value', '--variant': 'value', '--models': 'value', '--work-root': 'value', '--model-cache': 'value', '--completion-extra': 'value', '--reference-completion-extra': 'value', '--tokens': 'flag', '--parallel': 'value', '--ubatch': 'value', '--threads': 'value', '--device': 'value', '--port': 'value', '--quality-replays': 'value', '--rebuild': 'flag', '--clean': 'flag', '--jobs': 'value', '--help': 'flag' });
  if (args.help) { console.log('node tools/bench-loop.mjs [--candidate PATCH_DIR[,PATCH_DIR...]] [--variant baseline|profile|profile-gpu] [--reference ARTIFACT_ID] [--completion-extra JSON|@FILE] [--reference-completion-extra JSON|@FILE] [--tokens] [--models 0.8B] [--rebuild] [--clean] [--work-root DIR]'); return; }
  const referenceExtra = completionOptions(args['reference-completion-extra']), candidateExtra = completionOptions(args['completion-extra']);
  const variant = args.variant ?? 'baseline', root = workRoot(args['work-root']), timing = new Timings();
  const directory = inside(root, path.join(root, 'loops', String(Date.now()))); fs.mkdirSync(directory, { recursive: true });
  const report = { schema: 1, variant, status: 'running', directory };
  try {
    let reference;
    await timing.phase('基準成果物の照合・必要時ビルド', async () => {
      try { reference = resolveArtifact(root, args.reference ?? variant); }
      catch (e) {
        if (args.reference) throw e;
        const built = await build(['--variant', variant, '--work-root', root, '--jobs', args.jobs ?? '8']);
        report.referenceBuild = { artifactId: built.artifactId, inputHash: built.inputHash, timings: built.timings };
        reference = resolveArtifact(root, variant);
      }
    });
    const buildArgs = ['--variant', variant, '--work-root', root, '--jobs', args.jobs ?? '8'];
    if (args.candidate) buildArgs.push('--patches', args.candidate);
    if (args.rebuild) buildArgs.push('--rebuild'); if (args.clean) buildArgs.push('--clean');
    const candidate = args.candidate || args.rebuild || args.clean
      ? await timing.phase('候補ビルド', () => build(buildArgs))
      : { artifactDir: reference.directory, artifactId: reference.artifact, inputHash: reference.manifest?.inputHash, cacheHit: true };
    if (!candidate.artifactDir) throw new Error('候補にdistributionは指定できません');
    report.build = { artifactId: candidate.artifactId, inputHash: candidate.inputHash, cacheHit: candidate.cacheHit, timings: candidate.timings };
    const artifact = (resolved) => resolved.directory ? { directory: resolved.directory } : 'distribution';
    const cases = { cases: [
      { id: 'reference', artifact: artifact(reference), completionExtra: referenceExtra, tokens: !!args.tokens },
      { id: 'candidate', artifact: { directory: candidate.artifactDir }, completionExtra: candidateExtra, tokens: !!args.tokens },
    ], pairs: [{ referenceId: 'reference', candidateId: 'candidate', equivalent: false }] };
    const caseFile = path.join(directory, 'cases.json'); json(caseFile, cases);
    const profileArgs = ['--cases', caseFile, '--models', args.models ?? '0.8B', '--work-root', root];
    for (const key of ['model-cache', 'parallel', 'ubatch', 'threads', 'device', 'port', 'quality-replays']) if (args[key] != null) profileArgs.push('--' + key, args[key]);
    const measured = await timing.phase('基準・候補・基準の計測', () => profile(profileArgs));
    report.measurementDirectory = measured.outputDirectory; report.acceptance = measured.acceptance;
    report.status = measured.status; report.modelCachePreparation = measured.modelCachePreparation;
    return report;
  } catch (e) { report.status = 'failed'; report.error = e.stack; throw e; }
  finally {
    report.timings = timing.snapshot(); json(path.join(directory, 'loop.json'), report);
    const rows = ['| 工程 | 秒 |', '| --- | ---: |', ...report.timings.phases.map((row) => `| ${row.name} | ${(row.ms / 1000).toFixed(3)} |`), `| 全体 | ${(report.timings.totalMs / 1000).toFixed(3)} |`];
    fs.writeFileSync(path.join(directory, 'summary.md'), rows.join('\n') + '\n');
    console.log(rows.join('\n')); console.log(`1周の結果: ${directory}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) benchLoop().catch((e) => { console.error(e.stack); process.exitCode = 1; });
