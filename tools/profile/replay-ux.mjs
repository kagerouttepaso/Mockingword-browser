import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { LOG_TAG } from '../../extension/shared/messages.js';
import { message, sleep } from '../lib/browser.mjs';
import { readMhtml } from '../lib/mhtml.mjs';
import { openReplayPage, readMockingwordPairs } from '../lib/replay-page.mjs';
import { qualityStats } from './replay-quality.mjs';
import { installUxRecorder } from './replay-ux-dom.mjs';
import { analyzeUx, dispatchDiagnostics, median, uxMetricKeys } from './replay-ux-analysis.mjs';
import { browserStatus, launchUx, prepareMockVariant, prepareSakutto, prepareUxModels, setupUx, startUxTranslation } from './replay-ux-adapters.mjs';

const source = fileURLToPath(new URL('../../extension/', import.meta.url));
const files = { github: 'github-typescript-9998.mhtml', mdn: 'mdn-gpuadapter.mhtml', w3c: 'w3c-proposal.mhtml', wikipedia: 'wikipedia-ko.mhtml' };
const variantNames = ['default', 'a', 'b', 'ab', 'sakutto'];
const legacy = { width: 1200, height: 800 };
const install = `(${installUxRecorder.toString()})()`;
const snapshot = 'window.__uxReplay.snapshot()';
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fmt = (value) => value === null ? '未到達' : `${(value / 1000).toFixed(2)}秒`;

function pickList(value, valid, title) {
  if (!value) return valid;
  const list = value.split(',');
  if (list.some((id) => !valid.includes(id)) || new Set(list).size !== list.length) throw new Error(`${title}は ${valid.join(', ')} から重複なく選んでください`);
  return list;
}

function positive(value, title) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`${title}は正の整数で指定してください`);
  return Number(value);
}

async function openUxPage(browser, testCase, onConsole) {
  const page = await openReplayPage(browser, testCase.fixture, { viewport: testCase.viewport, onConsole });
  try {
    const window = await browser.send('Browser.getWindowForTarget', { targetId: page.targetId });
    if (!testCase.viewport && window.bounds.windowState !== 'maximized') {
      await browser.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'maximized' } });
      await browser.eval(page.session, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    }
    const bounds = (await browser.send('Browser.getWindowBounds', { windowId: window.windowId })).bounds;
    if (!testCase.viewport && bounds.windowState !== 'maximized') throw new Error('ブラウザーを最大化できません');
    await browser.eval(page.session, 'scrollTo({top:0, left:0, behavior:"instant"})');
    const inventory = await browser.eval(page.session, install);
    if (!inventory.total || !inventory.screen) throw new Error('訳す対象が無いか、初期画面に収まっていません');
    const [width, height] = inventory.metadata.viewport;
    if (testCase.viewport && (width !== testCase.viewport.width || height !== testCase.viewport.height)) throw new Error('指定したビューポートと一致しません');
    return { ...page, inventory, bounds };
  } catch (error) {
    await page.close();
    throw error;
  }
}

function signature(result) {
  const { viewport, devicePixelRatio, charset } = result.metadata;
  return hash(JSON.stringify([viewport, devicePixelRatio, charset,
    result.inventory.map(({ tag, source, initial, lead, collapsed }) => [tag, source, initial, lead, collapsed])]));
}

async function measure(testCase, variant, models, parallel, timeoutMs) {
  const launchedAt = Date.now();
  const browser = await launchUx(variant, testCase.viewport);
  try {
    const version = await browser.send('Browser.getVersion');
    const gpu = (await browser.send('SystemInfo.getInfo')).gpu.devices;
    const model = await setupUx(browser, variant, models, parallel);
    const status = await browserStatus(browser, variant, parallel);
    if (variant.sakutto) {
      if (await message(browser, { type: 'cache:clear' }) !== true) throw new Error('sakutto の訳文キャッシュを消去できません');
    } else {
      if (!(await message(browser, { type: 'cache-clear' }))?.ok) throw new Error('Mockingword の訳文キャッシュを消去できません');
      await browser.eval(browser.ext, 'chrome.storage.sync.set({debugLog:true})');
      await message(browser, { type: 'logs-clear' });
    }
    const consoles = [];
    const page = await openUxPage(browser, testCase, (entry) => { if (entry.text.startsWith(LOG_TAG)) consoles.push(entry); });
    try {
      await startUxTranslation(browser, variant, page);
      const native = await browser.waitFor(async () => variant.sakutto
        ? browser.eval(page.session, `(() => {
          const {sakuttoState: state, sakuttoProgress: progress} = document.documentElement.dataset;
          return ['translated','partial'].includes(state) && progress && !progress.endsWith('/0') ? {state, progress} : null;
        })()`)
        : consoles.find((entry) => entry.text.includes('全体の訳し終わり')), timeoutMs, 80);
      await sleep(350);
      const record = await browser.eval(page.session, snapshot);
      const ux = analyzeUx(record);
      const traces = variant.sakutto ? [] : (await message(browser, { type: 'logs-get' })).logs;
      if (!variant.sakutto && (!traces.some((event) => event.event === '送信対象選択') || !traces.some((event) => event.acquiredAt))) {
        throw new Error('Mockingword の送信・生成の診断ログを取得できません');
      }
      const nativePairs = variant.sakutto ? [] : await readMockingwordPairs(browser, page.session);
      const pairs = record.inventory.map((row) => ({ source: row.source, translation: row.rendered }));
      const finalStatus = await browserStatus(browser, variant, parallel);
      if (finalStatus.parallel !== status.parallel) throw new Error('計測中に同時実行数が変わりました');
      model.assertHealthy();
      return { case: testCase.id, variant: variant.name, ratio: variant.ratio, limits: variant.limits, fixtureSha256: testCase.sha256,
        inventorySha256: signature(record), version, extensionVersion: variant.version, gpu, model: model.snapshot(), status, finalStatus, bounds: page.bounds,
        wallMs: Date.now() - launchedAt, native: native || null, record, ux, traces,
        run: { totalMs: ux.totalMs, pairs }, quality: variant.sakutto ? null : qualityStats(nativePairs, traces),
        dispatch: variant.sakutto ? null : dispatchDiagnostics(traces, record.startAt, record.observedAt, status.parallel) };
    } finally { await page.close(); }
  } finally { await browser.close(); }
}

function summarize(results) {
  return Object.fromEntries(Object.entries(results).map(([name, runs]) => [name, {
    rounds: runs.length, nativeCompleted: runs.filter((run) => run.native).length,
    coverage: runs.map((run) => run.ux.counts.all),
    ms: Object.fromEntries(uxMetricKeys.map((key) => [key, {
      reached: runs.filter((run) => run.ux[key] !== null).length, median: median(runs.map((run) => run.ux[key])),
    }])),
    quality: runs.map((run) => run.quality), wallMedianMs: median(runs.map((run) => run.wallMs)),
  }]));
}

export async function runUxReplay(args) {
  const { values } = parseArgs({ args, options: {
    fixtures: { type: 'string' }, out: { type: 'string' }, pages: { type: 'string' }, variants: { type: 'string' },
    rounds: { type: 'string', default: '5' }, parallel: { type: 'string', default: '8' }, timeout: { type: 'string', default: '180' },
    sakutto: { type: 'string' }, 'sakutto-model': { type: 'string' }, inventory: { type: 'boolean' },
    'max-only': { type: 'boolean' },
  } });
  if (!values.fixtures || !values.out) throw new Error('--fixtures と --out を指定してください（docs/13_ページ翻訳のUX計測.md）');
  const names = values.inventory ? [] : pickList(values.variants, variantNames, '条件');
  const includesSakutto = names.includes('sakutto');
  if (includesSakutto && (!values.sakutto || !values['sakutto-model'])) throw new Error('sakutto の条件では --sakutto と --sakutto-model が必要です');
  const rounds = positive(values.rounds, '回数');
  const parallel = positive(values.parallel, '同時実行数');
  const timeoutMs = positive(values.timeout, '制限時間（秒）') * 1000;
  const cases = pickList(values.pages, Object.keys(files), 'ページ').flatMap((id) => {
    const file = path.join(values.fixtures, files[id]);
    const fixture = readMhtml(file);
    const sha256 = hash(fs.readFileSync(file));
    if (!fixture.parts.has(fixture.main)) throw new Error(`${files[id]} のページ本文がありません`);
    const main = { id, fixture, sha256, viewport: null };
    return id === 'github' && !values['max-only'] ? [main, { ...main, id: 'github-1200x800', viewport: legacy }] : [main];
  });
  const out = path.resolve(values.out);
  fs.mkdirSync(out, { recursive: true });
  if (fs.readdirSync(out).length) throw new Error('別の計測結果と混ぜないため、空の出力先を指定してください');
  if (values.inventory) {
    const browser = await launchUx({ extension: source });
    try {
      for (const testCase of cases) {
        const page = await openUxPage(browser, testCase);
        try {
          const record = await browser.eval(page.session, snapshot);
          json(path.join(out, `${testCase.id}.json`), { fixtureSha256: testCase.sha256, bounds: page.bounds, ...page.inventory, record });
          console.log(`${testCase.id}：${page.inventory.total}件（初期画面${page.inventory.screen}、非表示${page.inventory.hidden}、閉じた details ${page.inventory.collapsed}）、${page.inventory.metadata.viewport.join('×')}`);
        } finally { await page.close(); }
      }
    } finally { await browser.close(); }
    return;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mockingword-ux-'));
  try {
    const variants = names.map((name) => name === 'sakutto' ? prepareSakutto(values.sakutto)
      : prepareMockVariant(source, name, tempRoot));
    const models = await prepareUxModels({ mock: names.some((name) => name !== 'sakutto'), source,
      sakuttoFile: includesSakutto ? values['sakutto-model'] : null });
    const suite = {};
    for (const testCase of cases) {
      const results = Object.fromEntries(names.map((name) => [name, []]));
      let expected;
      for (let round = 0; round < rounds; round++) {
        for (let index = 0; index < variants.length; index++) {
          const variant = variants[(index + round) % variants.length];
          console.log(`${testCase.id} ${variant.name} ${round + 1}/${rounds}回目を開始`);
          const result = await measure(testCase, variant, models, parallel, timeoutMs);
          json(path.join(out, `${testCase.id}-${variant.name}-${round + 1}.json`), result);
          expected ??= result.inventorySha256;
          if (result.inventorySha256 !== expected) throw new Error(`${testCase.id} の画面設定または分母が一致しません。原始結果を確認してください`);
          results[variant.name].push(result);
          const { all } = result.ux.counts;
          console.log(`  画面内 ${fmt(result.ux.initialViewportMs)}・スクロール後 ${fmt(result.ux.scrollFollowMs)}・全体 ${fmt(result.ux.totalMs)}・網羅 ${all.translated}/${all.total}${result.native ? '' : '・拡張の終了通知なし'}`);
        }
      }
      suite[testCase.id] = summarize(results);
      json(path.join(out, 'summary.json'), suite);
    }
  } finally {
    const resolved = fs.realpathSync(tempRoot);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('mockingword-ux-')) throw new Error('計測用コピーの削除先が一時フォルダーにありません');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
