// 固定入力を取得し、専用の新しい checkout だけにパッチを適用する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPE, sha256, hashFile, workRoot, inside, json, run, readArgs } from './support.mjs';
import { buildPlan, loadPatchGroups, validateArtifacts } from './patch-plan.mjs';
import { applyBuildPatches } from './apply-patches.mjs';
import { Timings } from './timing.mjs';

export function patchFiles(variant) {
  const dirs = ['build', ...(variant.startsWith('profile') ? ['profile'] : [])];
  return dirs.flatMap((dir) => fs.readdirSync(path.join(RECIPE, 'patches', dir)).filter((f) => f.endsWith('.patch')).sort().map((f) => `patches/${dir}/${f}`));
}
async function image(pin, platform) {
  if (!pin.image) {
    await run('docker', ['pull', '--platform', platform, pin.tag]);
    const refs = JSON.parse(await run('docker', ['image', 'inspect', pin.tag, '--format', '{{json .RepoDigests}}'], { capture: true }));
    pin.image = refs.find((ref) => ref.startsWith(pin.tag.split(':')[0] + '@sha256:'));
    if (!pin.image) throw new Error(`${pin.tag} の digest を取得できませんでした`);
  }
  if (!/^\S+@sha256:[a-f0-9]{64}$/.test(pin.image)) throw new Error(`image digest が不正です: ${pin.image}`);
}
async function download(url, file, expected) {
  if (fs.existsSync(file)) {
    if (!expected || hashFile(file) === expected) return hashFile(file);
    throw new Error(`取得済みファイルの SHA-256 が違います: ${file}`);
  }
  // sakutto 0006 の再試行方針を移植。帰属と MIT 本文は licenses/sakutto-MIT.txt。
  for (let attempt = 1; attempt <= 5; ++attempt) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.subarray(0, 4).toString('hex') !== '504b0304') throw new Error('ZIP の先頭が不正です');
      const hash = sha256(data);
      if (expected && hash !== expected) throw new Error('Dawn ZIP の SHA-256 が違います');
      fs.writeFileSync(file, data);
      return hash;
    } catch (e) {
      if (attempt === 5 || /SHA-256/.test(e.message)) throw e;
      console.warn(`Dawn 取得 ${attempt}/5: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}
async function checkout(root, name, pin, dest) {
  const mirror = inside(root, path.join(root, 'git', `${name}.git`));
  if (!fs.existsSync(mirror)) await run('git', ['clone', '--mirror', pin.repository, mirror]);
  await run('git', ['--git-dir', mirror, 'cat-file', '-e', `${pin.commit}^{commit}`]);
  // 対象フォルダーはこの呼出しで初めて作る。既存 clone の reset/clean を行わない。
  // --shared の alternates は Windows 絶対パスになり Docker 内で壊れる。
  // 通常のローカル clone は object を hardlink/コピーし、Linux 側からも履歴を読める。
  await run('git', ['clone', '--no-checkout', mirror, dest]);
  await run('git', ['-C', dest, '-c', 'core.autocrlf=false', 'checkout', '--detach', pin.commit]);
  const head = await run('git', ['-C', dest, 'rev-parse', 'HEAD'], { capture: true });
  if (head !== pin.commit) throw new Error(`${name} の HEAD が違います`);
}
export async function build(argv = process.argv.slice(2)) {
  const args = readArgs(argv, { '--variant': 'value', '--work-root': 'value', '--jobs': 'value', '--patches': 'value', '--pins-only': 'flag', '--plan': 'flag', '--rebuild': 'flag', '--clean': 'flag', '--help': 'flag' });
  if (args.help) {
    console.log('node tools/wllama/build.mjs [--variant baseline|profile|profile-gpu] [--patches DIR[,DIR...]] [--work-root DIR] [--jobs N] [--plan] [--rebuild] [--clean] [--pins-only]');
    return;
  }
  const timing = new Timings(), variant = args.variant ?? 'baseline', jobs = Number(args.jobs ?? 8);
  if (!['baseline', 'profile', 'profile-gpu'].includes(variant)) throw new Error(`不明な variant: ${variant}`);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 256) throw new Error('--jobs は 1〜256 です');
  const pinsFile = path.join(RECIPE, 'pins.json'), pins = JSON.parse(fs.readFileSync(pinsFile, 'utf8'));
  const candidates = loadPatchGroups(args.patches);
  let plan = buildPlan(variant, pins, candidates);
  if (args.plan) {
    const output = { variant, artifactId: plan.artifactId, inputHash: plan.inputHash, configurationHash: plan.configurationHash, cmakeFlags: plan.cmakeFlags,
      patches: plan.patches.map(({ stage, file, sha256 }) => ({ stage, file, sha256 })), changedPaths: plan.changedPaths };
    console.log(JSON.stringify(output, null, 2)); return output;
  }
  const root = workRoot(args['work-root']);
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const invocationId = Date.now(), logFile = path.join(root, 'logs', `build-${variant}-${invocationId}.log`);
  const lock = path.join(root, '.build-lock'), fd = fs.openSync(lock, 'wx'), log = fs.createWriteStream(logFile);
  let logError;
  log.on('error', (error) => { logError ??= error; });
  const execute = (command, parameters) => run(command, parameters, { log });
  const output = (command, parameters) => run(command, parameters, { capture: true, log });
  let result;
  try {
    const allPinned = pins.emsdk.image && pins.node.image && pins.node.npmVersion && pins.dawn.sha256 && pins.wllama.packageLockSha256;
    const cachePointer = path.join(root, 'cache', 'artifacts', `${plan.inputHash}.json`);
    if (allPinned && !args.rebuild && !args.clean && !args['pins-only'] && fs.existsSync(cachePointer)) {
      result = await timing.phase('成果物キャッシュの照合', async () => {
        const cached = JSON.parse(fs.readFileSync(cachePointer, 'utf8'));
        const artifactDir = inside(root, path.resolve(root, cached.artifactDirectory));
        const manifest = validateArtifacts(artifactDir, plan.inputHash);
        const latest = { artifactDirectory: path.relative(root, artifactDir).replaceAll(path.sep, '/'), runId: cached.runId, inputHash: plan.inputHash, artifactId: plan.artifactId };
        json(path.join(root, 'latest', `${plan.artifactId}.json`), latest);
        return { variant, artifactId: plan.artifactId, artifactDir, inputHash: plan.inputHash, configurationHash: plan.configurationHash, runId: cached.runId, cacheHit: true, manifest };
      });
      console.log(`成果物キャッシュを再利用: ${result.artifactDir}`);
      return result;
    }
    await timing.phase('Docker環境・固定入力の確認', async () => {
      const info = JSON.parse(await output('docker', ['info', '--format', '{{json .}}']));
      if (info.OSType !== 'linux') throw new Error('Docker の Linux エンジンが必要です');
      await image(pins.emsdk, pins.platform); await image(pins.node, pins.platform);
      if (!pins.node.npmVersion) pins.node.npmVersion = await output('docker', ['run', '--rm', '--platform', pins.platform, pins.node.image, 'npm', '--version']);
      fs.mkdirSync(path.join(root, 'downloads'), { recursive: true });
      pins.dawn.sha256 = await download(pins.dawn.url, path.join(root, 'downloads', 'emdawn.zip'), pins.dawn.sha256);
      json(pinsFile, pins);
    });
    if (args['pins-only']) return;
    const runId = `${plan.artifactId}-${invocationId}`, runDir = inside(root, path.join(root, 'runs', runId)), source = path.join(runDir, 'source');
    fs.mkdirSync(runDir, { recursive: true }); fs.mkdirSync(path.join(root, 'git'), { recursive: true });
    await timing.phase('ソース準備', async () => {
      await checkout(root, 'wllama', pins.wllama, source);
      const gitlink = await output('git', ['-C', source, 'ls-tree', 'HEAD', 'llama.cpp']);
      if (!gitlink.includes(pins.llamaCpp.commit)) throw new Error('llama.cpp の gitlink が違います');
      await checkout(root, 'llama.cpp', pins.llamaCpp, path.join(source, 'llama.cpp'));
      const actual = hashFile(path.join(source, 'package-lock.json'));
      if (pins.wllama.packageLockSha256 && actual !== pins.wllama.packageLockSha256) throw new Error('package-lock.json が違います');
      pins.wllama.packageLockSha256 = actual; json(pinsFile, pins);
    });
    plan = buildPlan(variant, pins, candidates);
    const patchResult = await timing.phase('候補・計測パッチ適用', () => applyBuildPatches(plan, source, runDir, execute));
    json(path.join(runDir, 'build-request.json'), { schema: 2, runId, variant, artifactId: plan.artifactId, inputHash: plan.inputHash,
      configurationHash: plan.configurationHash, changedPaths: plan.changedPaths, cmakeFlags: plan.cmakeFlags, clean: !!args.clean, pins });
    const imageName = `plamo-wllama-builder:${sha256(pins.emsdk.image + pins.node.image + plan.recipe.Dockerfile).slice(0, 16)}`;
    await timing.phase('ビルダーイメージ準備', async () => {
      try { await output('docker', ['image', 'inspect', imageName, '--format', '{{.Id}}']); }
      catch { await execute('docker', ['build', '--platform', pins.platform, '--build-arg', `EMSDK_IMAGE=${pins.emsdk.image}`, '--build-arg', `NODE_IMAGE=${pins.node.image}`, '-t', imageName, RECIPE]); }
    });
    const volume = `plamo-wllama-${sha256(root).slice(0, 12)}`, sourceVolume = `${volume}-src-${plan.configurationHash.slice(0, 16)}`;
    await timing.phase('Docker起動・コンテナー内ビルド', () => execute('docker', ['run', '--rm', '--platform', pins.platform,
      '--mount', `type=bind,source=${RECIPE},target=/recipe,readonly`, '--mount', `type=bind,source=${root},target=/work`,
      '--mount', `type=bind,source=${source},target=/input,readonly`, '--mount', `type=volume,source=${volume},target=/cache`,
      '--mount', `type=volume,source=${sourceVolume},target=/source`, imageName, '--run-id', runId, '--jobs', String(jobs)]));
    const artifactDir = path.join(runDir, 'artifacts');
    result = await timing.phase('成果物取り出し・照合', async () => {
      const files = {};
      for (const file of ['index.js', 'wasm/wllama.wasm']) {
        const location = path.join(artifactDir, file);
        files[file] = { sha256: hashFile(location), bytes: fs.statSync(location).size };
        if (files[file].bytes < 1000) throw new Error(`${file} が小さすぎます`);
      }
      if (fs.readFileSync(path.join(artifactDir, 'wasm/wllama.wasm')).subarray(0, 4).toString('hex') !== '0061736d') throw new Error('WASM header が不正です');
      const bundle = fs.readFileSync(path.join(artifactDir, 'index.js'), 'utf8'), profiled = bundle.includes('__plamoPerfEvents') || bundle.includes('__plamoNative');
      if (variant.startsWith('profile') !== profiled) throw new Error('計測コードの有無がvariantと一致しません');
      const manifest = { schema: 2, variant, artifactId: plan.artifactId, inputHash: plan.inputHash, configurationHash: plan.configurationHash,
        pins, patches: patchResult.applied, instrumentation: patchResult.instrumentation, recipe: plan.recipe, cmakeFlags: plan.cmakeFlags,
        files, toolchain: JSON.parse(fs.readFileSync(path.join(artifactDir, 'toolchain.json'), 'utf8')),
        containerTimings: JSON.parse(fs.readFileSync(path.join(artifactDir, 'container-timings.json'), 'utf8')) };
      json(path.join(artifactDir, 'build-manifest.json'), manifest);
      const pointer = { artifactDirectory: path.relative(root, artifactDir).replaceAll(path.sep, '/'), runId, inputHash: plan.inputHash, artifactId: plan.artifactId };
      json(path.join(root, 'cache', 'artifacts', `${plan.inputHash}.json`), pointer);
      json(path.join(root, 'latest', `${plan.artifactId}.json`), pointer);
      return { variant, artifactId: plan.artifactId, artifactDir, inputHash: plan.inputHash, configurationHash: plan.configurationHash, runId, cacheHit: false, manifest };
    });
    console.log(`成果物: ${artifactDir}\nartifactId: ${plan.artifactId}\n入力: ${plan.inputHash}`);
    return result;
  } catch (e) { log.write(e.stack + '\n'); throw e; }
  finally {
    fs.closeSync(fd); fs.unlinkSync(lock);
    await new Promise((resolve) => { if (log.closed) resolve(); else { log.once('close', resolve); log.end(); } });
    const container = result && !result.cacheHit ? result.manifest.containerTimings : null;
    const dockerPhase = timing.rows.find((row) => row.name === 'Docker起動・コンテナー内ビルド');
    const report = { schema: 1, invocationId, variant, artifactId: plan.artifactId, inputHash: plan.inputHash, cacheHit: result?.cacheHit ?? false, ...timing.snapshot(), container,
      dockerOverheadMs: container && dockerPhase ? Math.max(0, dockerPhase.ms - container.totalMs) : null };
    if (result) result.timings = report;
    json(path.join(root, 'logs', `build-${variant}-${invocationId}-timings.json`), report);
    timing.print('ビルド '); console.log(`ビルドログ: ${logFile}`);
    if (logError) throw logError;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) build().catch((e) => { console.error(e.stack); process.exitCode = 1; });
