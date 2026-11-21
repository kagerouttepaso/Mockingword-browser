import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { launch, message, sleep } from '../lib/browser.mjs';
import { fileSha256, prepareModelCache } from '../lib/model-cache.mjs';
import { installModelInterception } from '../lib/model-cache-cdp.mjs';
import { sendBrowserAltA } from '../lib/windows-shortcut.mjs';

const sakuttoId = 'plamo-3-translate-0.8b-q4_k_m';
const sakuttoUrl = 'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/dbeb0856cb0b004b484f190bb71dd65876297013/plamo-3-translate-0.8b-Q4_K_M.gguf';
const sakuttoSha = '923b2f28a9856de1b8b3b610a7e59ded0b14d007466fd5dd526e6a9ecaadafdd';

function instrument(extension, relative, replacements) {
  const file = path.join(extension, relative);
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of replacements) {
    const count = typeof from === 'string' ? text.split(from).length - 1 : [...text.matchAll(from)].length;
    if (count !== 1) throw new Error(`計測の差し込み位置が1か所ではありません: ${relative} / ${from}`);
    text = text.replace(from, typeof to === 'function' ? to : () => to);
  }
  fs.writeFileSync(file, text);
}

export function prepareMockVariant(source, name, tempRoot) {
  const extension = path.join(tempRoot, name);
  fs.cpSync(source, extension, { recursive: true });
  instrument(extension, 'page/queue.js', [[/const chunk = nextChunk\([^\n]*\);/g, (selection) => `const selectedAt = performance.now();
    const pending = state.pending.size;
    ${selection}
    trace('送信対象選択', { selectedAt: performance.timeOrigin + selectedAt, ms: performance.now() - selectedAt, pending, selected: chunk.length });`]]);
  instrument(extension, 'page/state.js', [['data: { ...data, page: location.hostname }',
    'data: { ...data, page: location.hostname, pageAt: performance.timeOrigin + performance.now(), pagePending: state.pending.size }']]);
  instrument(extension, 'offscreen/offscreen.js', [
    ['const acquired = performance.now();', 'const acquired = performance.now();\n  let released;'],
    ['    release();', '    released = performance.now();\n    release();'],
    ['    startAt: Math.round(performance.timeOrigin + t0),', `    startAt: Math.round(performance.timeOrigin + t0),
    acquiredAt: performance.timeOrigin + acquired,
    releasedAt: performance.timeOrigin + released,`],
  ]);
  return { extension, name, version: JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8')).version };
}

export async function prepareUxModels({ mock, sakuttoFile, source }) {
  const result = {};
  if (mock) result.mock = await prepareModelCache({ models: ['0.8B'], allowDownload: false, extension: source });
  if (sakuttoFile) {
    const size = fs.statSync(sakuttoFile).size;
    if (size !== 573123200 || await fileSha256(sakuttoFile) !== sakuttoSha) throw new Error('sakutto の固定モデルのサイズまたは SHA-256 が一致しません');
    result.sakutto = { root: os.tmpdir(), entries: [{ id: sakuttoId, url: sakuttoUrl, rawUrl: sakuttoUrl.replace('/resolve/', '/raw/'),
      key: createHash('sha256').update(sakuttoUrl).digest('hex'), size, sha256: sakuttoSha, hashBasis: 'sakutto-catalog',
      downloadedBytes: 0, file: path.resolve(sakuttoFile) }] };
  }
  return result;
}

export function prepareSakutto(extensionPath) {
  const extension = path.resolve(extensionPath);
  const { version, host_permissions: hostPermissions } = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  if (version !== '1.9.0' || hostPermissions?.length) throw new Error('sakutto は未改変の 1.9.0 を指定してください');
  return { name: 'sakutto', extension, sakutto: true, version };
}

export function launchUx(variant, layout) {
  return launch({ port: 9571, extension: variant.extension, offline: true, maximized: !layout, gracefulClose: true,
    ...(variant.sakutto ? { workerPath: '/background.js', optionsPath: '/options.html' } : {}) });
}

export function settleWithin(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}が ${ms}ms 以内に終わりませんでした`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function setupUx(browser, variant, models, parallel) {
  const model = await installModelInterception(browser, models[variant.sakutto ? 'sakutto' : 'mock'],
    { log: () => {}, allowAbortedIntercept: !!variant.sakutto });
  if (!variant.sakutto) {
    await browser.eval(browser.ext, 'chrome.storage.sync.set({model:"0.8B",debugLog:false})');
    await browser.eval(browser.ext, `chrome.storage.local.set({device:"gpu",parallel:${parallel}})`);
    const warm = await settleWithin(message(browser, { type: 'speed-test' }), 120000, 'Mockingword のウォームアップ');
    if (!warm?.ok) throw new Error('Mockingword のウォームアップに失敗: ' + JSON.stringify(warm));
  } else {
    const current = await browser.waitFor(() => browser.eval(browser.ext, 'chrome.storage.local.get("settings").then(value => value.settings)'), 12000, 80);
    if (!current) throw new Error('sakutto の設定を読み込めません');
    const settings = { ...current, schemaVersion: 1, targetLanguage: 'ja', form: 'polite', display: 'replace',
      consent: { license: 'plamo-community', version: '2026-11-05', acceptedAt: '2026-11-05T00:00:00.000Z', ageNoticeShown: true },
      highQualityDismissed: true, sharedFolderOfferDismissed: true, glossary: [], tier: 'auto', pace: 'quality',
      engineSource: 'in-browser', translateVideoCaptions: false, gmailTranslateBanner: false };
    await browser.eval(browser.ext, `chrome.storage.local.set(${JSON.stringify({ settings, siteRules: {} })})`);
    if (!await message(browser, { type: 'model:download', modelId: sakuttoId })) throw new Error('sakutto がモデルの準備を開始できません');
    const ready = await browser.waitFor(async () => {
      const status = await message(browser, { type: 'engine:status' });
      return ['ready', 'loaded'].includes(status?.model?.state) && status;
    }, 75000, 500);
    if (!ready) throw new Error('sakutto に固定モデルを供給できません');
    if (!await settleWithin(message(browser, { type: 'engine:warm' }), 120000, 'sakutto のウォームアップ')) throw new Error('sakutto のウォームアップに失敗');
    const quality = await settleWithin(message(browser, { type: 'quality:sample' }), 30000, 'sakutto の品質サンプル');
    if (!quality?.milliseconds) await sleep(16000);
  }
  model.assertUsed();
  return model;
}

export async function browserStatus(browser, variant, parallel) {
  const status = await message(browser, { type: variant.sakutto ? 'engine:status' : 'status' });
  if (variant.sakutto ? status?.backend !== 'webgpu' || !status.plamoReady : status?.device !== 'gpu' || status.parallel !== parallel) {
    throw new Error(`指定の WebGPU 条件では動作していません: ${JSON.stringify(status)}`);
  }
  return status;
}

export async function startUxTranslation(browser, variant, page) {
  const start = () => browser.eval(page.session, 'window.__uxReplay.start()', page.contextId);
  if (!variant.sakutto) {
    await start();
    const result = await message(browser, { type: 'page-action', tabId: page.tabId, action: 'trans' });
    if (!result?.ok) throw new Error('Mockingword のページ翻訳に失敗: ' + JSON.stringify(result));
    return;
  }
  await browser.eval(browser.ext, `chrome.tabs.get(${page.tabId}).then(tab => chrome.windows.update(tab.windowId,{focused:true}))`);
  await browser.send('Page.bringToFront', {}, page.session);
  const processes = await browser.send('SystemInfo.getProcessInfo');
  await sendBrowserAltA(processes.processInfo.find((entry) => entry.type === 'browser')?.id, start);
  const started = await browser.waitFor(() => browser.eval(page.session, '!!document.documentElement.dataset.sakuttoState'), 3500, 80);
  if (!started) throw new Error('sakutto の Alt+A で翻訳が始まりません。権限は変更していません');
}
