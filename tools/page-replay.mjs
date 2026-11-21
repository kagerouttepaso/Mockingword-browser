// 実際のページの翻訳を、同じ条件で何度も流して測り、区間ごとに分ける（docs/10 の N7）。保存したページ（MHTML）を本物の経路
// （ページ側の段落集め・送信 → Service Worker → offscreen）で訳すので、バッチの入れ替わり、1行の step、ページ側の送り方（N8・N9）まで含めて測れる。
//
// 実行：node tools/page-replay.mjs <MHTML のパス> [--rounds 3] [--parallel 8] [--model 0.8B] [--out 結果フォルダー]
//         [--extension <extension フォルダー>]              … 基準の拡張を差し替える（既定はこのリポジトリの extension/）
//         [--artifact <成果物ID>]                       … 基準の vendor/wllama を差し替える（計測版 profile を渡すと step まで取れる）
//         [--compare <extension フォルダー>]            … ページ側・Service Workerの変更を候補として比べる
//         [--compare-artifact <成果物ID>]               … wllama の変更を候補として比べる（拡張はこのリポジトリのまま）
//       node tools/page-replay.mjs --save <URL> <保存先.mhtml>   … 公開ページを MHTML に保存する（計測対象づくり）
//
// - 候補を渡すと、基準→候補を rounds 回交互に測る（順番の偏りを避ける）。
// - 1回ごとにブラウザーを新しいプロファイルで起動し、モデルを読み込み、ウォームアップに同じページを1回訳してから、キャッシュを消して本番を1回測る。
// - ウォームアップは同じページではなく「今の設定で測る」（tune の計測対象）で行う。測る本番はそのブラウザーで初めて訳すページになるので、
//   prompt キャッシュは実際の使い方と同じ既定のまま（各スロットが前のリクエストと共通する先頭だけを使い回す）。--no-prompt-cache で切れる。
// - 調査用のログをオンにして、送信・受信・生成の時刻を集め、最初の行・画面内・送信・step に分ける（profile/replay-timeline.mjs）。
// - MHTML は計測対象の保存物なのでリポジトリに入れない（CLAUDE.md「作者の保存物はリポジトリに入れない」）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, message, sleep, enableModelCache } from './lib/browser.mjs';
import { readMhtml } from './lib/mhtml.mjs';
import { openReplayPage, readMockingwordPairs } from './lib/replay-page.mjs';
import { LOG_TAG } from '../extension/shared/messages.js';
import { analyzeEvents } from './lib/perf-trace.mjs';
import { workRoot } from './wllama/support.mjs';
import { resolveArtifact } from './profile/cases.mjs';
import { analyzeReplay, formatReplay } from './profile/replay-timeline.mjs';
import { comparePairs, qualityReport, qualityStats } from './profile/replay-quality.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const USAGE = '使い方：node tools/page-replay.mjs <MHTML> [--rounds 3] [--parallel 8] [--model 0.8B] [--out 結果フォルダー] [--artifact ID] [--compare <extension>] [--compare-artifact ID]\n       node tools/page-replay.mjs --save <URL> <保存先.mhtml>';

if (args[0] === '--ux') {
  const { runUxReplay } = await import('./profile/replay-ux.mjs');
  await runUxReplay(args.slice(1));
  process.exit(0);
}

// ---------------- 計測対象の保存 ----------------
if (args[0] === '--save') {
  const [, url, file] = args;
  if (!url || !file) { console.log(USAGE); process.exit(2); }
  const b = await launch();
  try {
    const { session } = await b.open(url, 6000);
    const { data } = await b.send('Page.captureSnapshot', { format: 'mhtml' }, session);
    fs.writeFileSync(file, data, 'latin1');
    console.log(`保存しました：${file}（${(data.length / 1024).toFixed(0)}KB）`);
  } finally { await b.close(); }
  process.exit(0);
}

const target = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!target || !fs.existsSync(target)) { console.log(USAGE); process.exit(2); }
const model = opt('--model', '0.8B');
const parallel = Number(opt('--parallel', 8));
const rounds = Number(opt('--rounds', 3));
const timeoutSec = Number(opt('--timeout', 600));
const outDir = opt('--out', null);
if (outDir) fs.mkdirSync(outDir, { recursive: true });

const mhtml = readMhtml(target);

/**
 * 拡張の一時コピーを作る。計測版のフック（profile/offscreen-hook.js）を足す。
 * 成果物IDを渡すと vendor/wllama を差し替える（profile 版なら step の記録がフックへたまる。通常版なら何もたまらない）。
 */
function prepare(source, artifact) {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-replay-'));
  fs.cpSync(source, ext, { recursive: true });
  let resolved = null;
  if (artifact) {
    resolved = resolveArtifact(workRoot(), artifact);
    for (const file of ['index.js', 'wasm/wllama.wasm']) fs.copyFileSync(path.join(resolved.directory, file), path.join(ext, 'vendor/wllama', file));
  }
  const file = path.join(ext, 'offscreen/offscreen.js');
  const text = fs.readFileSync(file, 'utf8');
  const from = '      prompt: message.prompt,';
  if (text.split(from).length !== 2) throw new Error(`${source} の offscreen.js に差し込み位置が見つかりません`);
  fs.writeFileSync(file, (args.includes('--no-prompt-cache') ? text.replace(from, '      cache_prompt: false,\n' + from) : text) + "\nimport './profile-hook.js';\n");
  fs.copyFileSync(path.join(HERE, 'profile/offscreen-hook.js'), path.join(ext, 'offscreen/profile-hook.js'));
  return { dir: ext, artifact: resolved?.artifact ?? '同梱', variant: resolved?.variant ?? null };
}
const REPO_EXT = path.resolve(HERE, '../extension');
const variants = [{ name: '基準', ...prepare(path.resolve(opt('--extension', REPO_EXT)), opt('--artifact', null)) }];
if (opt('--compare', null) || opt('--compare-artifact', null)) variants.push({ name: '候補', ...prepare(path.resolve(opt('--compare', REPO_EXT)), opt('--compare-artifact', null)) });

/** ページを開いて1回訳し、時間と記録を返す。 */
async function translatePage(b) {
  const consoles = [];
  const { session, tabId, close } = await openReplayPage(b, mhtml, { readyDelay: 2500, onConsole: (entry) => {
    if (entry.text.includes(LOG_TAG)) consoles.push(entry);
  } });
  // 訳文（訳し終わった行の途中表示を含む）が最初に入った時刻を、ページの中で取る（エポックのミリ秒）。
  await b.eval(session, `(() => {
    window.__replay = { first: null };
    new MutationObserver((recs) => {
      if (window.__replay.first !== null) return;
      for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('plamo-tr') && n.textContent.trim()) { window.__replay.first = performance.timeOrigin + performance.now(); return; }
    }).observe(document.documentElement, { childList: true, subtree: true });
  })()`);
  const t0 = Date.now();
  await message(b, { type: 'page-action', tabId, action: 'trans' });
  const done = await b.waitFor(async () => consoles.find((l) => l.text.includes('全体の訳し終わり')), timeoutSec * 1000, 200);
  if (!done) throw new Error('訳し終わりのログが届きません：' + consoles.slice(-3).map((c) => c.text).join(' / '));
  const firstLine = await b.eval(session, 'window.__replay.first');
  // 品質の比較用に、段落ごとの原文と訳文をページの順に取り出す。原文は、訳文の span を含む段落の中の、包まれた原文（data-plamo-orig）を集める。
  const pairs = await readMockingwordPairs(b, session);
  const screen = consoles.find((l) => l.text.includes('画面内の訳し終わり'));
  const num = (re, s) => (s?.match(re) ? Number(s.match(re)[1]) : null);
  await sleep(300); // 最後の生成の記録がService Workerへ届くのを待つ
  await close();
  return {
    t0, firstLine, consoles, pairs,
    totalMs: Math.round(num(/全体の訳し終わり ([\d.]+)秒/, done.text) * 1000),
    screenMs: screen ? Math.round(num(/画面内の訳し終わり ([\d.]+)秒/, screen.text) * 1000) : null,
    firstMs: firstLine === null ? null : Math.round(firstLine - t0),
    paragraphs: num(/、(\d+)段落/, done.text),
    requests: num(/問い合わせ(\d+)回/, done.text),
    tps: num(/([\d.]+) tok\/s/, done.text),
  };
}

/** 新しいプロファイルで起動し、ウォームアップの1回のあと、キャッシュとログを消して1回測る。 */
async function measure(variant) {
  const b = await launch({ extension: variant.dir });
  try {
    await enableModelCache(b, { models: [model] });
    await b.eval(b.ext, `chrome.storage.sync.set({ model: '${model}', debugLog: true })`);
    await b.eval(b.ext, `chrome.storage.local.set({ device: 'gpu', parallel: ${parallel} })`);
    await message(b, { type: 'translate-one', text: 'Warm up the model.' });
    const status = await message(b, { type: 'status' });
    const off = await b.attach((await b.waitFor(async () => (await b.targets()).find((t) => t.url.endsWith('/offscreen/offscreen.html')), 20000, 100)).targetId);
    await message(b, { type: 'speed-test' }); // ウォームアップ（シェーダーの準備など、最初の1回だけ遅い分を除く）。同じページは訳さない
    await message(b, { type: 'cache-clear' });
    await message(b, { type: 'logs-clear' });
    await b.eval(off, 'globalThis.__plamoProfile.reset()');
    const run = await translatePage(b);
    const traces = (await message(b, { type: 'logs-get' })).logs;
    const events = await b.eval(off, 'globalThis.__plamoProfile.drain()');
    const steps = events.length ? analyzeEvents(events).steps : [];
    const analysis = analyzeReplay({ t0: run.t0, firstLine: run.firstLine, consoles: run.consoles, traces, steps, parallel });
    return { run, traces, events, analysis, quality: qualityStats(run.pairs, traces), device: status.device, adapter: status.adapter ?? null, loadedParallel: status.parallel };
  } finally { await b.close(); }
}

const median = (a) => { const s = a.filter((x) => x !== null && x !== undefined).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const fmt = (ms) => (ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(2) + '秒');
const results = Object.fromEntries(variants.map((v) => [v.name, []]));
console.log(`計測対象：${path.basename(target)}（${mhtml.main}）、${model}、同時${parallel}本、${rounds}回`);
for (const v of variants) console.log(`  ${v.name}：wllama ${v.artifact}${v.variant === 'profile' || v.variant === 'profile-gpu' ? '（計測版。時間は計測の上乗せを含む）' : ''}`);
for (let i = 0; i < rounds; i++) {
  for (const v of variants) {
    const m = await measure(v);
    const r = m.run;
    results[v.name].push({ ...r, consoles: undefined, analysis: m.analysis, quality: m.quality });
    console.log(`${i + 1}回目 ${v.name}：全体 ${fmt(r.totalMs)}・画面内 ${fmt(r.screenMs)}・最初の行 ${fmt(r.firstMs)}・${r.paragraphs}段落・問い合わせ${r.requests}回・${r.tps} tok/s（${m.device}、${m.loadedParallel}本、${m.adapter ?? ''}）`);
    console.log(formatReplay(m.analysis));
    const q = m.quality;
    console.log(`  訳の崩れ：行がずれた依頼 ${q.fallbackRequests}/${q.requests}・打ち切り ${q.cutGenerations}・マーカー ${q.brokenMarks}・英字のまま ${q.untranslated}・空 ${q.empty}（${q.paragraphs}段落）`);
    if (outDir) fs.writeFileSync(path.join(outDir, `${v.name === '基準' ? 'reference' : 'candidate'}-${i + 1}.json`), JSON.stringify({ variant: v.name, artifact: v.artifact, ...m }, null, 1));
  }
}
const pick = (rs, f) => median(rs.map(f));
const summary = Object.fromEntries(Object.entries(results).map(([name, rs]) => [name, {
  totalMs: pick(rs, (r) => r.totalMs), screenMs: pick(rs, (r) => r.screenMs), firstMs: pick(rs, (r) => r.firstMs), tps: pick(rs, (r) => r.tps),
  collectedMs: pick(rs, (r) => r.analysis.firstLine.collectedMs), firstSendMs: pick(rs, (r) => r.analysis.firstLine.firstSendMs), firstTokenMs: pick(rs, (r) => r.analysis.firstLine.firstTokenMs),
  meanGenerating: pick(rs, (r) => r.analysis.flow.meanGenerating), stepMs: pick(rs, (r) => r.analysis.steps?.stepMs), gapMs: pick(rs, (r) => r.analysis.steps?.gapMs),
}]));
console.log('中央値');
for (const [name, s] of Object.entries(summary)) console.log(`  ${name}：全体 ${fmt(s.totalMs)}・画面内 ${fmt(s.screenMs)}・最初の行 ${fmt(s.firstMs)}（段落集め ${fmt(s.collectedMs)}・最初の送信 ${fmt(s.firstSendMs)}・最初の字 ${fmt(s.firstTokenMs)}）・${s.tps} tok/s・生成中 ${s.meanGenerating}本${s.stepMs !== null ? `・step の中 ${fmt(s.stepMs)}・step の間 ${fmt(s.gapMs)}` : ''}`);
if (variants.length > 1) {
  const d = (k) => { const a = summary.基準[k], c = summary.候補[k]; return a && c ? `${(((c - a) / a) * 100).toFixed(1)}%` : '—'; };
  console.log(`  候補の差：全体 ${d('totalMs')}・画面内 ${d('screenMs')}・最初の行 ${d('firstMs')}`);
}
// 訳の比較は各版の1回目どうしで行う（温度0なので、同じ版なら同じ訳になるのが普通）。
if (variants.length > 1) {
  const [a, c] = [results.基準[0], results.候補[0]];
  const comparison = comparePairs(a.pairs, c.pairs);
  console.log(`訳の比較：${comparison.compared}段落のうち同じ ${comparison.same}・変わった ${comparison.changed}`);
  if (outDir) fs.writeFileSync(path.join(outDir, 'quality.md'), qualityReport({ names: ['基準', '候補'], stats: [a.quality, c.quality], comparison, target: path.basename(target) }));
}
if (outDir) fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ target: path.basename(target), url: mhtml.main, model, parallel, rounds, variants: variants.map((v) => ({ name: v.name, artifact: v.artifact })), summary }, null, 2));
for (const v of variants) fs.rmSync(v.dir, { recursive: true, force: true });
process.exit(0);
