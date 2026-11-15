// Docker内。構成が同じ間はLinuxのソース・CMake・npm・JS成果物を保持する。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashFile, sha256, readArgs, json, run as streamCommand } from './support.mjs';
import { Timings } from './timing.mjs';
import { syncBuildSources, writeChanged } from './build-cache.mjs';

const timer = new Timings();
const args = readArgs(process.argv.slice(2), { '--run-id': 'value', '--jobs': 'value' });
if (!/^(baseline|profile|profile-gpu)(-candidate-[a-f0-9]{12})?-\d+$/.test(args['run-id'])) throw new Error('run-id が不正です');
const runDir = `/work/runs/${args['run-id']}`, request = JSON.parse(fs.readFileSync(`${runDir}/build-request.json`, 'utf8'));
if (!/^[a-f0-9]{64}$/.test(request.configurationHash) || !/^[a-f0-9]{64}$/.test(request.inputHash)) throw new Error('入力hashが不正です');
const source = '/source', cache = `/cache/configurations/${request.configurationHash}`, build = `${cache}/build`;
fs.mkdirSync(cache, { recursive: true });
process.env.npm_config_cache = '/cache/npm-downloads'; process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
process.env.GIT_CONFIG_COUNT = '4';
for (const [index, directory] of [source, `${source}/llama.cpp`, '/input', '/input/llama.cpp'].entries()) {
  process.env[`GIT_CONFIG_KEY_${index}`] = 'safe.directory'; process.env[`GIT_CONFIG_VALUE_${index}`] = directory;
}
const output = (command, parameters, cwd = source) => execFileSync(command, parameters, { cwd, encoding: 'utf8' }).trim();
const run = (command, parameters, cwd = source) => execFileSync(command, parameters, { cwd, stdio: 'inherit' });
const stats = { sourceFilesCopied: 0, compiledObjects: 0, linkSteps: 0, cmakeCacheHit: false, npmCacheHit: false, jsCacheHit: false };
let completed = false;
process.on('exit', () => { if (!completed) json(`${runDir}/artifacts/container-timings.json`, { ...timer.snapshot(), stats, completed }); });
await timer.phase('ソース差分同期', async () => {
  const stateFile = `${cache}/source-state.json`;
  const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
  const first = !previous || previous.commit !== request.pins.wllama.commit || !fs.existsSync(`${source}/CMakeLists.txt`);
  stats.sourceFilesCopied = syncBuildSources('/input', source, request.changedPaths, first ? null : previous.changedPaths).length;
  for (const directory of [source, `${source}/llama.cpp`]) {
    fs.mkdirSync(directory, { recursive: true });
    writeChanged(path.join(directory, '.git'), Buffer.from(`gitdir: ${directory === source ? '/input/.git' : '/input/llama.cpp/.git'}\n`));
  }
  json(stateFile, { commit: request.pins.wllama.commit, changedPaths: request.changedPaths });
});
process.env.SOURCE_DATE_EPOCH = output('git', ['show', '-s', '--format=%ct', 'HEAD']);
if (output('node', ['--version']) !== request.pins.node.version || output('npm', ['--version']) !== request.pins.node.npmVersion) throw new Error('Node/npmの固定値が違います');
await timer.phase('Emscriptenシステム・portキャッシュ準備', async () => {
  const key = sha256(request.pins.emsdk.image + request.pins.dawn.sha256), directory = `/cache/emscripten/${key}`;
  stats.emscriptenCacheHit = fs.existsSync(`${directory}/initialized.json`);
  if (!stats.emscriptenCacheHit) {
    fs.mkdirSync(directory, { recursive: true });
    fs.cpSync('/emsdk/upstream/emscripten/cache', directory, { recursive: true });
    json(`${directory}/initialized.json`, { sdk: request.pins.emsdk.image, dawn: request.pins.dawn.sha256 });
  }
  process.env.EM_CACHE = directory;
});
const dawnRoot = `/cache/dawn/${request.pins.dawn.sha256}`, dawn = `${dawnRoot}/emdawnwebgpu_pkg`;
await timer.phase('Dawn準備', async () => {
  if (hashFile('/work/downloads/emdawn.zip') !== request.pins.dawn.sha256) throw new Error('DawnのSHA-256が違います');
  if (!fs.existsSync(`${dawn}/emdawnwebgpu.port.py`)) run('python3', ['-m', 'zipfile', '-e', '/work/downloads/emdawn.zip', dawnRoot]);
});
await timer.phase('npm依存準備', async () => {
  const key = sha256(request.pins.node.image + request.pins.wllama.packageLockSha256);
  const installRoot = `/cache/npm-install/${key}`; fs.mkdirSync(installRoot, { recursive: true });
  const marker = `${installRoot}/complete.json`;
  stats.npmCacheHit = fs.existsSync(marker) && fs.existsSync(`${installRoot}/node_modules/.bin/tsup`);
  if (!stats.npmCacheHit) {
    for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(`${source}/${file}`, `${installRoot}/${file}`);
    run('npm', ['ci', '--no-audit', '--no-fund'], installRoot); json(marker, { key });
  }
  if (!fs.existsSync(`${source}/node_modules`)) fs.symlinkSync(`${installRoot}/node_modules`, `${source}/node_modules`);
});
await timer.phase('CMake構成', async () => {
  if (request.clean) fs.rmSync(build, { recursive: true, force: true });
  stats.cmakeCacheHit = fs.existsSync(`${build}/CMakeCache.txt`);
  if (!stats.cmakeCacheHit) run('emcmake', ['cmake', '-S', source, '-B', build, ...request.cmakeFlags, `-DEMDAWNWEBGPU_DIR=${dawn}`]);
});
await timer.phase('C++コンパイル・リンク', async () => {
  let text = '';
  try { await streamCommand('cmake', ['--build', build, '--target', 'wllama', '-j', args.jobs ?? '8'], { cwd: source, onOutput(chunk) { text += chunk; } }); }
  finally { stats.compiledObjects = (text.match(/Building (?:CXX|C|ASM) object/g) ?? []).length; stats.linkSteps = (text.match(/Linking .* executable/g) ?? []).length; }
});
await timer.phase('WASM後処理・JS生成', async () => {
  fs.mkdirSync(`${source}/src/wasm`, { recursive: true });
  writeChanged(`${source}/src/wasm/wllama.js`, fs.readFileSync(`${build}/wllama.js`));
  run('node', ['scripts/add_wasm_names.js', `${build}/wllama.wasm`, 'src/wasm/wllama.wasm']);
  run('node', ['cpp/generate_glue_prototype.js']);
  run('bash', ['scripts/build_worker.sh']);
});
let jsRoot;
await timer.phase('JS bundle', async () => {
  const files = ['package.json', 'package-lock.json', 'index.ts', 'tsup.config.ts', 'tsconfig.build.json', 'cpp/generate_glue_prototype.js'];
  for (const directory of ['src', 'scripts']) for (const relative of fs.readdirSync(`${source}/${directory}`, { recursive: true })) {
    const file = `${directory}/${relative}`;
    if (/\.(ts|js|json|sh)$/.test(file) && fs.statSync(`${source}/${file}`).isFile()) files.push(file);
  }
  const key = sha256(JSON.stringify({ node: request.pins.node.image, inputs: files.sort().map((file) => [file, hashFile(`${source}/${file}`)]) }));
  jsRoot = `/cache/js/${key}`; stats.jsCacheHit = fs.existsSync(`${jsRoot}/index.js`);
  if (!stats.jsCacheHit) { run('npm', ['run', 'build:tsup']); fs.mkdirSync(jsRoot, { recursive: true }); fs.copyFileSync(`${source}/esm/index.js`, `${jsRoot}/index.js`); }
});
await timer.phase('成果物取り出し', async () => {
  const directory = `${runDir}/artifacts`; fs.mkdirSync(`${directory}/wasm`, { recursive: true });
  fs.copyFileSync(`${jsRoot}/index.js`, `${directory}/index.js`); fs.copyFileSync(`${source}/src/wasm/wllama.wasm`, `${directory}/wasm/wllama.wasm`);
  json(`${directory}/toolchain.json`, { node: output('node', ['--version']), npm: output('npm', ['--version']), emcc: output('emcc', ['--version']), cmake: output('cmake', ['--version']).split('\n')[0], llamaBuildNumber: output('git', ['-C', `${source}/llama.cpp`, 'rev-list', '--count', 'HEAD']) });
});
completed = true; json(`${runDir}/artifacts/container-timings.json`, { ...timer.snapshot(), stats, completed }); timer.print('コンテナー ');
