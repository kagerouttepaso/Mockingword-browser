// 普段の計測と同じBrave起動経路で確認し、診断はTEMPへ保存する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { launch } from '../../../lib/browser.mjs';
import { probeMatrix } from './probe-browser.mjs';
import { inspectCandidate } from './inspect-emdawn.mjs';

export function readOptions(argv) {
  const options = { powerPreference: 'high-performance' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') options.help = true;
    else if (argv[i] === '--port') options.port = Number(argv[++i]);
    else if (argv[i] === '--power') options.powerPreference = argv[++i];
    else throw new Error(`不明な引数: ${argv[i]}`);
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) throw new Error('portは1024〜65535です');
  if (!['high-performance', 'low-power'].includes(options.powerPreference)) throw new Error('powerはhigh-performanceかlow-powerです');
  return options;
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return port;
}
export async function runProbe(argv = process.argv.slice(2)) {
  const options = readOptions(argv);
  if (options.help) { console.log('node tools/wllama/patches/prefill-matrix/probe.mjs [--port N] [--power high-performance|low-power]'); return; }
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-matrix-probe-'));
  let browser;
  const record = { schema: 1, createdAt: new Date().toISOString(), normalLaunch: true, status: 'running', recommendation: 'hold', options };
  try {
    console.log('emdawnのAPIとBraveのmatrix公開条件を確認します。モデルは読み込みません。');
    record.toolchain = await inspectCandidate(output);
    browser = await launch({ port: options.port ?? await availablePort(), extensionWaitMs: 0 });
    record.browser = await browser.send('Browser.getVersion');
    record.result = await browser.eval(browser.ext, `(${probeMatrix.toString()})(${JSON.stringify({ powerPreference: options.powerPreference })})`);
    record.status = 'measured';
    if (record.toolchain.status === 'api-confirmed' && record.result.recommendation === 'implementation-candidate') record.recommendation = 'implementation-candidate';
    console.log(JSON.stringify(record.result, null, 2));
    console.log(`候補emdawnのAPI確認: ${record.toolchain.status}`);
    console.log(record.recommendation === 'implementation-candidate' ? '判定：実装の着手候補。モデルの品質・速度検証を別途行う。' : '判定：現行条件での実装は保留。JSONのtoolchainとresult.reasonを確認する。');
    return record;
  } catch (error) { record.status = 'failed'; record.error = String(error.stack ?? error); throw error; }
  finally {
    fs.writeFileSync(path.join(output, 'probe.json'), JSON.stringify(record, null, 2) + '\n');
    console.log(`確認結果: ${path.join(output, 'probe.json')}`);
    if (browser) await (browser.closeFast ?? browser.close).call(browser);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runProbe().catch(error => { console.error(error); process.exitCode = 1; });
}
