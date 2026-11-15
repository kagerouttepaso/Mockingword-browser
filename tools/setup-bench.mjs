// 別PCでも、固定入力の通常版と候補を準備し、基準→候補→基準を1周だけ測る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT, RECIPE, workRoot, inside, json, readArgs, hashFile } from './wllama/support.mjs';
import { buildPlan, loadPatchGroups, validateArtifacts } from './wllama/patch-plan.mjs';
import { modelCacheRoot, prepareModelCache } from './lib/model-cache.mjs';

const HELP = 'node tools/setup-bench.mjs [--skip-check] [--work-root DIR] [--model-cache DIR] [--jobs 8] [--parallel 4] [--port 9350]';
// 同梱した通常版と同じ並び（extension/vendor/wllama/README.md）。
const PATCH_GROUPS = ['commands', 'sampling', 'matmul', 'result', 'prefill', 'matmul-h8', 'attn'];
// 候補は拡張の既定（GPU sampling・token-only・temperature 単独）を使う。基準は配布物と同じ設定へ戻す（docs/06）。両方とも prompt キャッシュを効かせない（docs/09「計測の妥当性の見直し」）。
const COMPLETION = { cache_prompt: false };
const REFERENCE_COMPLETION = { cache_prompt: false, backend_sampling: false, backend_sampling_token_only: false, samplers: null };

export function setupArgs(argv) {
  const args = readArgs(argv, { '--skip-check': 'flag', '--work-root': 'value', '--model-cache': 'value', '--jobs': 'value', '--parallel': 'value', '--port': 'value', '--help': 'flag' });
  for (const [key, fallback, valid] of [
    ['jobs', 8, (n) => Number.isInteger(n) && n >= 1 && n <= 256],
    ['parallel', 4, (n) => [1, 2, 3, 4, 6, 8].includes(n)],
    ['port', 9350, (n) => Number.isInteger(n) && n >= 1024 && n <= 65535],
  ]) {
    args[key] = Number(args[key] ?? fallback);
    if (!valid(args[key])) throw new Error(`--${key} の値が不正です。${HELP}`);
  }
  return args;
}

export function requireNode(version) {
  const match = /^v?(\d+)\.\d+\.\d+/.exec(version);
  if (!match || Number(match[1]) < 24) throw new Error(`Node 24以上が必要です（現在 ${version}）。Node 24を導入し、新しいPowerShellで node --version を確認してください。`);
}

export function requirePins(pins) {
  if (!pins || typeof pins !== 'object' || Array.isArray(pins)) throw new Error('tools/wllama/pins.json は固定版のJSONオブジェクトが必要です。固定済みのpins.jsonを含むこのリポジトリを取得し直してください。');
  const sha = /^[a-f0-9]{64}$/, commit = /^[a-f0-9]{40}$/, image = /^\S+@sha256:[a-f0-9]{64}$/;
  const checks = [
    pins.schema === 1 && pins.platform === 'linux/amd64',
    commit.test(pins.wllama?.commit ?? '') && commit.test(pins.llamaCpp?.commit ?? ''),
    typeof pins.wllama?.repository === 'string' && typeof pins.llamaCpp?.repository === 'string',
    sha.test(pins.wllama?.packageLockSha256 ?? '') && sha.test(pins.dawn?.sha256 ?? ''),
    image.test(pins.emsdk?.image ?? '') && image.test(pins.node?.image ?? ''),
    typeof pins.dawn?.url === 'string' && /^\d+\.\d+\.\d+$/.test(pins.node?.npmVersion ?? ''),
  ];
  if (checks.some((ok) => !ok)) throw new Error('tools/wllama/pins.json の版・commit・image digest・SHA・npm版を固定してください。固定済みのpins.jsonを含むこのリポジトリを取得し直してください。セットアップ中に版を決め直すことはありません。');
}

export function longPathEnvironment(env) {
  const count = env.GIT_CONFIG_COUNT ?? '0';
  if (!/^\d+$/.test(count) || !Number.isSafeInteger(Number(count)) || Number(count) > 10000) throw new Error('GIT_CONFIG_COUNT が不正です。起動元のGit環境変数を確認してください。');
  // Gitはclone/checkoutの両方へ継承する。既存の設定を保ち、最後にこの呼出しの設定を追加する。
  return { ...env, GIT_CONFIG_COUNT: String(Number(count) + 1), [`GIT_CONFIG_KEY_${Number(count)}`]: 'core.longpaths', [`GIT_CONFIG_VALUE_${Number(count)}`]: 'true' };
}

export function findBrave(env, isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } }) {
  if (env.BRAVE) {
    if (!isFile(env.BRAVE)) throw new Error(`BRAVE の実行ファイルが見つかりません: ${env.BRAVE}。BRAVEには引用符を含めずbrave.exeのパスを指定してください。`);
    return path.resolve(env.BRAVE);
  }
  const bases = [env.ProgramW6432, env.ProgramFiles ?? path.join(env.SystemDrive ?? 'C:', 'Program Files'), env['ProgramFiles(x86)'], env.LOCALAPPDATA];
  const candidates = [...new Set(bases.filter(Boolean).map((base) => path.join(base, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')))];
  const found = candidates.find(isFile);
  if (!found) throw new Error(`Brave が見つかりません。Braveを導入するか、PowerShellで $env:BRAVE='brave.exeのフルパス' を指定してください。確認先: ${candidates.join(', ')}`);
  return path.resolve(found);
}

export function execute(command, args, { env = process.env, cwd = PROJECT, capture = false, tee = false, acceptable = [0], timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', tail = '', timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs) : undefined;
    for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) stream.on('data', (chunk) => {
      tail = (tail + chunk).slice(-12000);
      if (capture && stream === child.stdout) stdout = (stdout + chunk).slice(-131072);
      if (!capture || tee) target.write(chunk);
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} の応答が${timeoutMs / 1000}秒以内にありません。`));
      else if (!acceptable.includes(code)) reject(new Error(`${command} が終了コード ${code} で失敗しました。\n${tail}`));
      else resolve({ code, stdout: stdout.trim() });
    });
  });
}

async function phase(label, action, hint = '') {
  try { return await action(); }
  catch (error) { throw new Error(`${label}: ${error.message}${hint ? '\n対処: ' + hint : ''}`, { cause: error }); }
}

export async function preflight({ env, version, run = execute, log = console.log }) {
  requireNode(version);
  log(`Node ${version}: 確認済み`);
  const brave = findBrave(env);
  log(`Brave: ${brave}`);
  const git = await phase('Gitの確認', () => run('git', ['--version'], { env, capture: true, timeoutMs: 30000 }), 'Git for Windowsを導入し、新しいPowerShellで git --version を確認してください。');
  const original = await run('git', ['config', '--get', 'core.longpaths'], { env, capture: true, acceptable: [0, 1], timeoutMs: 30000 });
  const childEnv = { ...longPathEnvironment(env), BRAVE: brave };
  const effective = await run('git', ['config', '--bool', '--get', 'core.longpaths'], { env: childEnv, capture: true, timeoutMs: 30000 });
  if (effective.stdout !== 'true') throw new Error('子プロセスの core.longpaths=true が反映されません。起動元の GIT_CONFIG_PARAMETERS などのGit環境変数を確認してください。');
  log(`${git.stdout}: core.longpaths=${original.stdout || '未設定'} → このセットアップの子プロセスではtrue`);
  const docker = await phase('Dockerの確認', async () => {
    const result = await run('docker', ['info', '--format', '{{json .}}'], { env: childEnv, capture: true, timeoutMs: 30000 });
    const info = JSON.parse(result.stdout);
    if (info.OSType !== 'linux') throw new Error(`Linuxエンジンが必要です（現在 ${info.OSType ?? '不明'}）。`);
    return info;
  }, 'Docker Desktopを起動し、Linux containersへ切り替えて docker info が成功することを確認してください。');
  log(`Docker: Linuxエンジン応答あり（${docker.ServerVersion ?? '版不明'}）`);
  return { env: childEnv, brave, docker };
}

export function setupPlans(pins) {
  const patches = PATCH_GROUPS.map((group) => path.join(RECIPE, 'patches', group)).join(',');
  return [
    { name: '基準', plan: buildPlan('baseline', pins), patches: null },
    { name: '候補（commands,sampling,matmul）', plan: buildPlan('baseline', pins, loadPatchGroups(patches)), patches },
  ];
}

export function cachedArtifact(root, plan) {
  const cache = path.join(root, 'cache', 'artifacts', `${plan.inputHash}.json`);
  const latest = path.join(root, 'latest', `${plan.artifactId}.json`);
  const reasons = [];
  for (const file of [cache, latest]) {
    if (!fs.existsSync(file)) continue;
    try {
      const pointer = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pointer.inputHash !== plan.inputHash || pointer.artifactId !== plan.artifactId) throw new Error('入力hashまたは成果物IDが異なります');
      const directory = inside(root, path.resolve(root, pointer.artifactDirectory));
      const manifest = validateArtifacts(directory, plan.inputHash);
      if (manifest.artifactId !== plan.artifactId || manifest.variant !== plan.variant) throw new Error('manifestの成果物IDまたはvariantが異なります');
      const normalized = { artifactDirectory: path.relative(root, directory).replaceAll(path.sep, '/'), runId: pointer.runId, inputHash: plan.inputHash, artifactId: plan.artifactId };
      // cacheだけ／latestだけが残った場合も、バイトの照合後に参照を復元する。
      json(cache, normalized); json(latest, normalized);
      return { ready: true, directory, manifest };
    } catch (error) { reasons.push(error.message); }
  }
  return { ready: false, reason: reasons.join(' / ') || '対応する照合済み成果物がありません' };
}

export async function ensureArtifact(spec, { root, env, jobs, run = execute, log = console.log }) {
  const previous = cachedArtifact(root, spec.plan);
  if (previous.ready) { log(`${spec.name}: 済み（入力hash・成果物SHA照合、ビルド省略）`); return { ...previous, reused: true }; }
  log(`${spec.name}: ビルドします（${previous.reason}）`);
  const args = [path.join(RECIPE, 'build.mjs'), '--variant', 'baseline', '--work-root', root, '--jobs', String(jobs)];
  if (spec.patches) args.push('--patches', spec.patches);
  // 壊れたcache pointerもbuild側のcache hitにせず、ログ・旧成果物を残して作り直す。
  args.push('--rebuild');
  await phase(`${spec.name}のビルド`, () => run(process.execPath, args, { env }), `WORK/logsのbuildログを確認してください。メモリー不足なら --jobs 4 で再実行してください。Filename too longの場合はログのGit呼出しとcore.longpathsを確認してください。`);
  const built = cachedArtifact(root, spec.plan);
  if (!built.ready) throw new Error(`${spec.name}の成果物を照合できません: ${built.reason}。pins・パッチ・ビルド台本が実行中に更新されていないか確認し、再実行してください。`);
  return { ...built, reused: false };
}

export async function setupBench(argv = process.argv.slice(2), { env = process.env, version = process.version, run = execute, prepareModels = prepareModelCache, log = console.log } = {}) {
  const args = setupArgs(argv);
  if (args.help) { log(HELP); return { status: 'help' }; }
  requireNode(version);
  const pinsFile = path.join(RECIPE, 'pins.json');
  const pins = await phase('固定版の確認', async () => {
    const value = JSON.parse(fs.readFileSync(pinsFile, 'utf8')); requirePins(value); return value;
  });
  log(`固定版: wllama ${pins.wllama.version ?? ''} ${pins.wllama.commit} / llama.cpp ${pins.llamaCpp.commit}`);
  const context = await preflight({ env, version, run, log });
  const root = workRoot(args['work-root'] ?? env.PLAMO_BUILD_ROOT ?? path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'plamo-translate-build'));
  const cacheRoot = modelCacheRoot(args['model-cache'] ?? env.PLAMO_MODEL_CACHE ?? path.join(root, 'models'));
  await phase('作業領域の準備', async () => { fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(cacheRoot, { recursive: true }); }, 'PLAMO_BUILD_ROOTまたは --work-root でリポジトリ外の書込み可能な場所を指定してください。');
  log(`WORK: ${root}\n共有モデル: ${cacheRoot}`);
  const artifacts = [];
  const result = { schema: 1, status: 'preparing', startedAt: new Date().toISOString(), pinsSha256: hashFile(pinsFile), artifacts, modelCache: [], check: { skipped: !!args['skip-check'] } };
  const stateFile = path.join(root, 'logs', 'setup-bench.json');
  json(stateFile, result);
  try {
    const specs = setupPlans(pins);
    for (const spec of specs) {
      const artifact = await ensureArtifact(spec, { root, env: context.env, jobs: args.jobs, run, log });
      artifacts.push({ artifactId: spec.plan.artifactId, inputHash: spec.plan.inputHash, directory: artifact.directory, reused: artifact.reused });
      json(stateFile, result);
    }
    if (JSON.stringify(JSON.parse(fs.readFileSync(pinsFile, 'utf8'))) !== JSON.stringify(pins)) throw new Error('実行中にpins.jsonの固定値が変わりました。固定版の差分を統率者へ確認し、再実行してください。');
    result.pinsSha256 = hashFile(pinsFile);
    const prepared = await phase('0.8B共有モデルの準備・SHA照合', () => prepareModels({ models: ['0.8B'], extension: path.join(PROJECT, 'extension'), cacheRoot, allowDownload: env.PLAMO_MODEL_CACHE_OFFLINE !== '1', log }), 'キャッシュの本体と照合票を確認してください。破損時は該当する2ファイルをリポジトリ外へ退避し、再実行してください。未準備ならPLAMO_MODEL_CACHE_OFFLINEを解除し、Hugging Faceへ接続できる環境で実行してください。');
    result.modelCache = prepared.entries.map(({ id, sha256, hashBasis, downloadedBytes }) => ({ id, sha256, hashBasis, downloadedBytes }));
    result.status = 'prepared'; json(stateFile, result);
    const profileArgs = [path.join(PROJECT, 'tools', 'profile.mjs'), '--models', '0.8B', '--reference', artifacts[0].artifactId, '--candidate', artifacts[1].artifactId,
      '--completion-extra', JSON.stringify(COMPLETION), '--reference-completion-extra', JSON.stringify(REFERENCE_COMPLETION), '--quality-replays', '0', '--parallel', String(args.parallel), '--port', String(args.port), '--work-root', root, '--model-cache', cacheRoot];
    log(`基準: ${artifacts[0].artifactId}\n候補: ${artifacts[1].artifactId}`);
    if (args['skip-check']) log('確認計測を省略しました。次回は --skip-check を外して実行してください。');
    else {
      log('確認計測: 0.8B、基準→候補→基準、quality-replays=0（profile.mjsを1回起動）');
      try {
        const measured = await run(process.execPath, profileArgs, { env: context.env, capture: true, tee: true, acceptable: [0, 2] });
        const output = [...measured.stdout.matchAll(/^計測結果: (.+)\r?$/gm)].at(-1)?.[1].trim();
        if (!output) throw new Error('profile.mjsが結果フォルダーを返しませんでした。WORK/profilesのreport.jsonを確認してください。');
        const summary = inside(root, path.join(output, 'summary.md'));
        if (!fs.statSync(summary).isFile()) throw new Error(`summary.mdがありません: ${summary}`);
        result.check = { skipped: false, exitCode: measured.code, summary };
        result.status = measured.code === 2 ? 'review-required' : 'checked';
        log(`確認計測のsummary.md: ${summary}`);
        if (measured.code === 2) log('計測は完了しました。訳文・目印などの照合に要確認の差があるため、summary.mdとreport.jsonを統率者へ渡してください（終了コード2）。');
      } catch (error) {
        result.status = 'failed'; result.check = { skipped: false, error: error.message };
        throw new Error(`確認計測: ${error.message}\n対処: WORK/profilesのreport.jsonとbrowser.jsonlを確認してください。CDPポート競合なら --port 9351 で再実行してください。`, { cause: error });
      }
    }
  } catch (error) {
    result.status = 'failed'; result.error = error.message; throw error;
  } finally { result.finishedAt = new Date().toISOString(); json(stateFile, result); }
  log(`セットアップ記録: ${stateFile}\n再実行は同じ node tools/setup-bench.mjs。ビルドとモデルはSHA照合で再利用し、確認計測は新しく行います。`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupBench().then((result) => { if (result.status === 'review-required') process.exitCode = 2; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
