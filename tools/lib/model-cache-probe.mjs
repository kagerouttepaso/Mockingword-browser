// 小さい試験データだけで、実 Brave の offscreen と子WorkerへのURL差替えを確認する。
// モデルの初回取得や推論は行わない。既存の共有モデルキャッシュにも書き込まない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { launch } from './browser.mjs';
import { installModelInterception } from './model-cache-cdp.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('node tools/lib/model-cache-probe.mjs [--port 9359]'); process.exit(0); }
for (let i = 0; i < args.length; i += 2) if (args[i] !== '--port' || !args[i + 1]) throw new Error('使い方: model-cache-probe.mjs [--port 9359]');
const index = args.indexOf('--port');
const port = Number(index >= 0 ? args[index + 1] : 9359);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port が不正です');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plamo-model-cache-probe-'));
const body = Buffer.from('GGUF: ローカル供給の接続確認');
const sha256 = crypto.createHash('sha256').update(body).digest('hex');
const url = `https://huggingface.co/test/plamo-model-cache-probe/resolve/${'0'.repeat(40)}/probe.gguf`;
const file = path.join(root, 'probe.gguf');
await fs.writeFile(file, body);
let b;
try {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`CDP ポート ${port} を使えません。--port で空いている番号を指定してください`)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(resolve));
  });
  b = await launch({ port });
  const entry = { id: 'probe', url, rawUrl: url.replace('/resolve/', '/raw/'), size: body.length,
    key: crypto.createHash('sha256').update(url).digest('hex'), sha256, file, downloadedBytes: 0, hashBasis: 'test-fixture' };
  const cache = await installModelInterception(b, { root, entries: [entry] });
  await b.eval(b.ext, `chrome.offscreen.createDocument({ url: 'offscreen/offscreen.html', reasons: ['WORKERS'], justification: '試験用ローカル供給の接続確認' })`);
  const target = await b.waitFor(async () => (await b.targets()).find((info) => info.url.endsWith('/offscreen/offscreen.html')), 10000, 100);
  if (!target) throw new Error('offscreen が起動しませんでした');
  const session = await b.attach(target.targetId);
  const direct = await b.eval(session, `(async () => {
    const response = await fetch(${JSON.stringify(url)});
    const bytes = await response.arrayBuffer();
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
    const part = await fetch(${JSON.stringify(url)}, { headers: { Range: 'bytes=0-3' } });
    const pointer = await (await fetch(${JSON.stringify(entry.rawUrl)})).text();
    return { sha256, rangeStatus: part.status, prefix: await part.text(), pointer };
  })()`);
  if (direct.sha256 !== sha256 || direct.rangeStatus !== 206 || direct.prefix !== 'GGUF' || !direct.pointer.includes(sha256)) throw new Error('offscreen の供給結果が一致しません');
  const worker = await b.eval(session, `new Promise((resolve, reject) => {
    const source = 'onmessage = async (event) => { try { const response = await fetch(event.data); const bytes = await response.arrayBuffer(); const hash = await crypto.subtle.digest("SHA-256", bytes); postMessage({ sha256: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, "0")).join("") }); } catch(error) { postMessage({ error: String(error) }); } };';
    const script = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(script);
    const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(script); reject(new Error('子Workerの供給確認がタイムアウトしました')); }, 15000);
    worker.onmessage = (event) => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(script); resolve(event.data); };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(script); reject(new Error(event.message)); };
    worker.postMessage(${JSON.stringify(url)});
  })`);
  if (worker.sha256 !== sha256) throw new Error(`子Workerの供給結果が一致しません: ${JSON.stringify(worker)}`);
  cache.assertUsed();
  console.log(JSON.stringify({ ok: true, fixtureOnly: true, offscreen: true, worker: true, range: true, externalModelBytes: 0, audit: cache.snapshot() }, null, 2));
} catch (e) { console.error(e.stack); process.exitCode = 1; }
finally {
  try { if (b) { await b.close(); b.modelCache?.assertHealthy(); } }
  finally {
    if (path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('試験用の一時パスが違います');
    await fs.rm(root, { recursive: true, force: true });
  }
}
