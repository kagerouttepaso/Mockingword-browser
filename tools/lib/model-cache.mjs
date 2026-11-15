// 試験用のモデル共有キャッシュ。固定URL・サイズ・SHA-256を確認し、ブラウザー起動とは独立して準備する。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_EXTENSION = fileURLToPath(new URL('../../extension/', import.meta.url));
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function modelCacheRoot(value) {
  const index = process.argv.indexOf('--model-cache');
  const argument = index >= 0 ? process.argv[index + 1] : undefined;
  if (index >= 0 && (!argument || argument.startsWith('--'))) throw new Error('--model-cache のフォルダーを指定してください');
  const base = process.env.PLAMO_BUILD_ROOT ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'plamo-translate-build');
  const root = path.resolve(value ?? argument ?? process.env.PLAMO_MODEL_CACHE ?? path.join(base, 'models'));
  for (let folder = path.dirname(DEFAULT_EXTENSION); ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, '.git'))) {
      const relative = path.relative(folder, root);
      if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('共有モデルキャッシュはリポジトリの外に置いてください');
      break;
    }
    if (path.dirname(folder) === folder) break;
  }
  return root;
}
export function parseModelCatalog(source) {
  const block = source.match(/\bconst MODELS\s*=\s*\{([\s\S]*?)^\};/m);
  if (!block) throw new Error('offscreen.js の固定モデル一覧が見つかりません');
  const catalog = [];
  for (const match of block[1].matchAll(/['"]([^'"]+)['"]\s*:\s*\{([^{}]*)\}/g)) {
    const [, id, body] = match;
    const url = body.match(/\burl:\s*['"]([^'"]+)['"]/)?.[1];
    const size = Number(body.match(/\bsize:\s*(\d+)/)?.[1]);
    const sha256 = body.match(/\bsha256:\s*['"]([a-f0-9]{64})['"]/)?.[1] ?? null;
    if (!url || !Number.isSafeInteger(size) || size <= 0) throw new Error(`${id} のURLまたはサイズが不正です`);
    const parsed = new URL(url);
    if (parsed.origin !== 'https://huggingface.co' || !/\/resolve\/[a-f0-9]{40}\/.+\.gguf$/.test(parsed.pathname) || parsed.search || parsed.hash) throw new Error(`${id} のURLをコミットへ固定してください`);
    catalog.push({ id, url, rawUrl: url.replace('/resolve/', '/raw/'), size, sha256, key: digest(url) });
  }
  if (!catalog.length || new Set(catalog.map((model) => model.id)).size !== catalog.length) throw new Error('モデル一覧が空か、名前が重複しています');
  return catalog;
}
export function readModelCatalog(extension = DEFAULT_EXTENSION) {
  return parseModelCatalog(fs.readFileSync(path.join(extension, 'offscreen/offscreen.js'), 'utf8'));
}
export async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function verify(model, file, metadataFile) {
  const fileExists = fs.existsSync(file), metadataExists = fs.existsSync(metadataFile);
  if (!fileExists && !metadataExists) return null;
  if (!fileExists || !metadataExists) throw new Error(`モデルキャッシュの本体と照合票が揃っていません: ${file}`);
  const metadata = JSON.parse(await fsp.readFile(metadataFile, 'utf8'));
  if (metadata.schema !== 1 || metadata.url !== model.url || metadata.size !== model.size || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error(`モデルキャッシュの照合票が一致しません: ${metadataFile}`);
  if ((await fsp.stat(file)).size !== model.size) throw new Error(`モデルキャッシュのサイズが一致しません: ${file}`);
  if (model.sha256 && metadata.sha256 !== model.sha256) throw new Error(`モデルの固定 SHA-256 が照合票と一致しません: ${file}`);
  if (await fileSha256(file) !== metadata.sha256) throw new Error(`モデルキャッシュの SHA-256 が一致しません: ${file}`);
  return { ...model, file, sha256: metadata.sha256, hashBasis: metadata.hashBasis, downloadedBytes: 0 };
}
async function readPointer(model, fetchImpl) {
  const response = await fetchImpl(model.rawUrl, { signal: AbortSignal.timeout(30000), headers: { 'Accept-Encoding': 'identity' } });
  if (!response.ok || !response.body) throw new Error(`LFS 照合値の取得 HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) throw new Error('LFS pointer が8KBを超えています');
      chunks.push(Buffer.from(part.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString('utf8');
  const sha256 = text.match(/^oid sha256:([a-f0-9]{64})\r?$/m)?.[1];
  const size = Number(text.match(/^size (\d+)\r?$/m)?.[1]);
  if (!sha256 || size !== model.size) throw new Error('LFS pointer の SHA-256 またはサイズが不正です');
  return sha256;
}
export async function ensureCachedModel(model, { cacheRoot, allowDownload = process.env.PLAMO_MODEL_CACHE_OFFLINE !== '1', fetchImpl = fetch, log = console.log } = {}) {
  const root = modelCacheRoot(cacheRoot);
  await fsp.mkdir(root, { recursive: true });
  const stem = `${model.id.replace(/[^A-Za-z0-9._-]/g, '_')}-${model.key}`;
  const file = path.join(root, stem + '.gguf'), metadataFile = path.join(root, stem + '.json'), lockFile = path.join(root, stem + '.lock');
  // 他の台本が取得中なら、その照合票の確定を待ってから検証する。
  let lock;
  let announcedWait = false;
  const deadline = Date.now() + 900000;
  while (!lock) {
    try { lock = await fsp.open(lockFile, 'wx'); }
    catch (e) {
      if (e.code !== 'EEXIST' || Date.now() >= deadline) throw new Error(`モデルキャッシュの取得ロックを使えません: ${lockFile}`, { cause: e });
      if (!announcedWait) { log(`共有モデル ${model.id}: 別の台本の準備完了を待っています`); announcedWait = true; }
      await wait(300);
    }
  }
  const partial = file + `.part-${process.pid}-${crypto.randomUUID()}`;
  const metadataPartial = metadataFile + `.part-${process.pid}-${crypto.randomUUID()}`;
  try {
    const cached = await verify(model, file, metadataFile);
    if (cached) { log(`共有モデル ${model.id}: SHA-256 照合済み、外部取得 0 bytes`); return cached; }
    if (!allowDownload) throw new Error(`共有モデル ${model.id} が未準備です。offline モードでは取得しません。model-cache.mjs --models ${model.id} を先に実行してください`);
    let expected = model.sha256, hashBasis = 'source';
    if (!expected) {
      try { expected = await readPointer(model, fetchImpl); hashBasis = 'huggingface-lfs'; }
      catch (e) { log(`共有モデル ${model.id}: 公開照合値を得られないため、初回の算出値を記録します（${e.message}）`); hashBasis = 'first-download'; }
    }
    log(`共有モデル ${model.id}: 固定URLから初回取得 ${model.size} bytes`);
    const response = await fetchImpl(model.url, { signal: AbortSignal.timeout(900000), headers: { 'Accept-Encoding': 'identity' } });
    if (response.status !== 200 || !response.body) throw new Error(`モデル取得 HTTP ${response.status}: ${model.url}`);
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) !== model.size) throw new Error('モデル取得の Content-Length が固定値と一致しません');
    const hash = crypto.createHash('sha256');
    let bytes = 0, prefix = Buffer.alloc(0);
    const check = new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > model.size) { callback(new Error('モデル取得のサイズが固定値を超えました')); return; }
      if (prefix.length < 4) prefix = Buffer.concat([prefix, chunk]).subarray(0, 4);
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), check, fs.createWriteStream(partial, { flags: 'wx' }));
    const sha256 = hash.digest('hex');
    if (bytes !== model.size || prefix.toString('ascii') !== 'GGUF') throw new Error('取得したモデルのサイズまたは GGUF header が不正です');
    if (expected && sha256 !== expected) throw new Error('取得したモデルの SHA-256 が照合値と一致しません');
    const metadata = { schema: 1, url: model.url, size: bytes, sha256, hashBasis };
    await fsp.writeFile(metadataPartial, JSON.stringify(metadata, null, 2) + '\n', { flag: 'wx' });
    await fsp.rename(partial, file);
    await fsp.rename(metadataPartial, metadataFile);
    log(`共有モデル ${model.id}: 保存済み SHA-256 ${sha256}（${hashBasis}）`);
    return { ...model, file, sha256, hashBasis, downloadedBytes: bytes };
  } finally {
    await Promise.all([fsp.rm(partial, { force: true }), fsp.rm(metadataPartial, { force: true })]);
    await lock.close(); await fsp.unlink(lockFile);
  }
}
export async function prepareModelCache({ models = ['0.8B'], cacheRoot, extension = DEFAULT_EXTENSION, ...options } = {}) {
  const catalog = readModelCatalog(extension);
  const entries = [];
  for (const id of [...new Set(models)]) {
    const model = catalog.find((entry) => entry.id === id);
    if (!model) throw new Error(`未定義のモデルです: ${id}`);
    entries.push(await ensureCachedModel(model, { cacheRoot, ...options }));
  }
  return { root: modelCacheRoot(cacheRoot), entries, catalog };
}
export function parseByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error('未対応または不正な Range');
  let start, end;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error('不正な suffix Range'); start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new Error('Range が範囲外');
  return { start, end };
}
export const MODEL_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Range, If-None-Match, Content-Type, Authorization',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
  'Access-Control-Allow-Private-Network': 'true', 'Cross-Origin-Resource-Policy': 'cross-origin',
};
export function lfsPointer(entry) { return `version https://git-lfs.github.com/spec/v1\noid sha256:${entry.sha256}\nsize ${entry.size}\n`; }
export async function startModelServer(entries) {
  const routes = new Map(), stats = { requests: 0, dataRequests: 0, dataBytes: 0, pointerRequests: 0 };
  for (const entry of entries) { routes.set(`/models/${entry.key}/file`, { entry, kind: 'model' }); routes.set(`/models/${entry.key}/pointer`, { entry, kind: 'pointer' }); }
  const server = http.createServer(async (request, response) => {
    stats.requests++;
    const route = routes.get(new URL(request.url, 'http://127.0.0.1').pathname);
    const headers = { ...MODEL_CORS_HEADERS, 'Cache-Control': 'no-store' };
    if (!route) { response.writeHead(404, headers); response.end(); return; }
    if (request.method === 'OPTIONS') { response.writeHead(204, headers); response.end(); return; }
    if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, headers); response.end(); return; }
    const { entry, kind } = route;
    if (kind === 'pointer') {
      stats.pointerRequests++;
      const body = Buffer.from(lfsPointer(entry));
      response.writeHead(200, { ...headers, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body); return;
    }
    const etag = `"${entry.sha256}"`;
    let range;
    try { range = request.method === 'GET' && (!request.headers['if-range'] || request.headers['if-range'] === etag) ? parseByteRange(request.headers.range, entry.size) : null; }
    catch { response.writeHead(416, { ...headers, 'Content-Range': `bytes */${entry.size}`, 'Content-Length': 0 }); response.end(); return; }
    const start = range?.start ?? 0, end = range?.end ?? entry.size - 1;
    const content = { ...headers, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: etag, 'Content-Length': end - start + 1 };
    if (range) content['Content-Range'] = `bytes ${start}-${end}/${entry.size}`;
    if (request.method === 'HEAD') { response.writeHead(200, content); response.end(); return; }
    stats.dataRequests++;
    response.writeHead(range ? 206 : 200, content);
    const stream = fs.createReadStream(entry.file, { start, end });
    stream.on('data', (chunk) => { stats.dataBytes += chunk.length; });
    try { await pipeline(stream, response); }
    catch { if (!response.destroyed) response.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const urls = new Map();
  for (const entry of entries) { urls.set(entry.url, { entry, kind: 'model', localUrl: `${origin}/models/${entry.key}/file` }); urls.set(entry.rawUrl, { entry, kind: 'pointer', localUrl: `${origin}/models/${entry.key}/pointer` }); }
  return { origin, urls, stats, async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = {}, argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; ++i) {
      const key = argv[i];
      if (['--help', '--offline'].includes(key)) args[key] = true;
      else if (['--models', '--cache-root', '--model-cache', '--extension'].includes(key)) {
        if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${key} の値が必要です`);
        args[key] = argv[++i];
      } else throw new Error(`不明な引数: ${key}`);
    }
    if (args['--help']) console.log('node tools/lib/model-cache.mjs [--models 0.8B,2B] [--cache-root DIR] [--extension DIR] [--offline]');
    else {
      const prepared = await prepareModelCache({ models: (args['--models'] ?? '0.8B,2B').split(','), cacheRoot: args['--cache-root'] ?? args['--model-cache'], extension: args['--extension'] ?? DEFAULT_EXTENSION, allowDownload: !args['--offline'] && process.env.PLAMO_MODEL_CACHE_OFFLINE !== '1' });
      console.log(JSON.stringify({ cacheRoot: prepared.root, models: prepared.entries.map(({ id, url, size, sha256, hashBasis, downloadedBytes }) => ({ id, url, size, sha256, hashBasis, downloadedBytes })) }, null, 2));
    }
  } catch (e) { console.error(e.stack); process.exitCode = 1; }
}
