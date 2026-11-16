// ページの翻訳の速さを測る。保存した MHTML（ブラウザーの「名前を付けて保存」→「ウェブページ、1 ファイル」）か URL を訳し、
// 画面内・全体の時間、問い合わせの回数、リンクの残り方を出す。続けて読み直し、控えから置き換える2回目も測る。
// 実行：node tools/bench.mjs <MHTML のパス | URL> [--model 0.8B|2B] [--device auto|gpu|cpu] [--parallel 4] [--ubatch 512]
// MHTML は作者の環境の保存物なのでリポジトリに入れない。MHTML のときは保存した HTML・CSS・画像だけを返し、ほかの通信は止める。
// 結果の残し方は docs/06_開発と検証.md「速さの測定」。
import { launch, message, sleep, tabIdOf } from './lib/browser.mjs';
import { partHeaders, readMhtml } from './lib/mhtml.mjs';
import { MARK_TAG } from '../extension/shared/markup.js';
import { LOG_TAG } from '../extension/shared/messages.js';
// モデルは固定URLの共有キャッシュから供給し、MHTML 用の横取りと分ける。
import { enableModelCache } from './lib/browser.mjs';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
if (!target) {
  console.log('使い方：node tools/bench.mjs <MHTML のパス | URL> [--model 0.8B|2B] [--device auto|gpu|cpu] [--parallel 4] [--ubatch 512]');
  process.exit(2);
}


const mhtml = /^https?:/.test(target) ? null : readMhtml(target);
const url = mhtml ? mhtml.main : target;
const b = await launch();
try {
  await enableModelCache(b, { models: [opt('model', '0.8B')] });
  await b.eval(b.ext, `chrome.storage.sync.set({ model: '${opt('model', '0.8B')}', debugLog: true })`);
  await b.eval(b.ext, `chrome.storage.local.set({ device: '${opt('device', 'auto')}', parallel: ${Number(opt('parallel', 4))}, ubatch: ${Number(opt('ubatch', 512))} })`);
  const warm = Date.now();
  await message(b, { type: 'translate-one', text: 'Warm up the model.' });
  b.modelCache.assertUsed();
  console.log(`モデルの取得と読み込み ${((Date.now() - warm) / 1000).toFixed(1)}秒`);

  async function run(label) {
    const { targetId, session } = await b.open('about:blank', 300);
    await b.send('Runtime.enable', {}, session);
    const logs = [];
    b.on((m) => {
      if (m.sessionId !== session) return;
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type !== 'debug') {
        const text = m.params.args.map((a) => a.value ?? '').join(' ');
        if (text.includes(LOG_TAG)) logs.push(text);
      }
      if (m.method === 'Fetch.requestPaused') {
        const part = mhtml.parts.get(m.params.request.url);
        // 拡張機能自身の読み込み（ページ側のモジュール）は通す。
        if (m.params.request.url.startsWith('chrome-extension://')) b.send('Fetch.continueRequest', { requestId: m.params.requestId }, session).catch(() => {});
        else if (part) b.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: partHeaders(part), body: part.body.toString('base64') }, session).catch(() => {});
        else b.send('Fetch.failRequest', { requestId: m.params.requestId, errorReason: 'BlockedByClient' }, session).catch(() => {});
      }
    });
    if (mhtml) await b.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
    await b.send('Page.navigate', { url }, session);
    await sleep(2500);
    const tabId = await tabIdOf(b, targetId);
    const shot = opt('shot', null);
    if (shot) await b.screenshot(session, shot.replace('{label}', label.slice(0, 3)));
    if (shot) console.log('  画面に見えている段落の場所', JSON.stringify(await b.eval(session, `(() => {
      const MAIN = 'main, article, [role="main"], .markdown-body';
      const NAV = 'nav, aside, header, footer, [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], [role="menu"], [role="menubar"]';
      const out = {};
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!/[A-Za-z]{3}/.test(n.data)) continue;
        const el = n.parentElement; if (!el || el.closest('script,style,svg')) continue;
        const r = el.getBoundingClientRect(); if (!(r.bottom > 0 && r.top < innerHeight && r.width > 0 && el.checkVisibility())) continue;
        const main = el.closest(MAIN), nav = el.closest(NAV);
        const k = (nav && (!main || main.contains(nav)) ? 'ナビ:' + (nav.tagName + '.' + nav.className).slice(0, 40) : main ? '本文' : 'その他:' + (el.closest('[class]')?.className ?? '').slice(0, 30));
        out[k] = (out[k] ?? 0) + 1;
      }
      return out;
    })()`)));
    // 訳文が入った時刻を、ページの中で記録する（拡張機能とは別のものさし。直す前と後を同じように測る）。
    await b.eval(session, `(() => {
      window.__bench = { t0: performance.now(), arrived: new Map() };
      new MutationObserver((recs) => { for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('plamo-tr')) window.__bench.arrived.set(n, performance.now()); })
        .observe(document.documentElement, { childList: true, subtree: true });
    })()`);
    const t0 = Date.now();
    await message(b, { type: 'page-action', tabId, action: 'trans' });
    const done = await b.waitFor(async () => logs.some((l) => l.includes('全体の訳し終わり')), Number(opt('timeout', 600)) * 1000, 500);
    if (!done) console.log('  訳し終わりのログが届かない', JSON.stringify({ logs: logs.slice(-5), tr: await b.eval(session, `document.querySelectorAll('.plamo-tr').length`), bar: await b.eval(session, `!!document.querySelector('.plamo-ui-host')`) }));
    const r = await b.eval(session, `(() => {
      const trs = [...document.querySelectorAll('.plamo-tr')];
      return { paragraphs: trs.length, withLinks: trs.filter((t) => t.querySelector('a[href]')).length, brokenMarks: trs.filter((t) => new RegExp(${JSON.stringify(MARK_TAG.source)}).test(t.textContent)).length };
    })()`);
    console.log(`${label}：${((Date.now() - t0) / 1000).toFixed(1)}秒、${logs.filter((l) => /訳し終わり/.test(l)).join(' / ')}`);
    console.log(`  訳文 ${r.paragraphs}段落、リンクを含む ${r.withLinks}段落、崩れた目印 ${r.brokenMarks}`);
    // 画面に見えている訳文を、本文・ナビ（ナビゲーション・サイドバー・ヘッダー・フッター・メニュー）・その他に分け、訳し終えた時刻を出す。
    const v = await b.eval(session, `(() => {
      const MAIN = 'main, article, [role="main"], .markdown-body';
      const NAV = 'nav, aside, header, footer, [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], [role="menu"], [role="menubar"]';
      const out = { 本文: [], ナビ: [], その他: [] };
      for (const [el, t] of window.__bench.arrived) {
        if (!el.isConnected) continue;
        const rc = el.getBoundingClientRect();
        if (!(rc.bottom > 0 && rc.top < innerHeight && rc.width > 0)) continue;
        const main = el.closest(MAIN), nav = el.closest(NAV);
        const region = nav && (!main || main.contains(nav)) ? 'ナビ' : main ? '本文' : 'その他';
        out[region].push((t - window.__bench.t0) / 1000);
      }
      return Object.fromEntries(Object.entries(out).map(([k, a]) => [k, a.length ? { 段落: a.length, 最後: +Math.max(...a).toFixed(1), 中央: +a.sort((x, y) => x - y)[a.length >> 1].toFixed(1) } : null]));
    })()`);
    console.log(`  画面内：${Object.entries(v).filter(([, x]) => x).map(([k, x]) => `${k} ${x.段落}段落（中央 ${x.中央}秒・最後 ${x.最後}秒）`).join('、')}`);
  }

  await run('1回目');
  await run('2回目（読み直し、控えから置き換える）');
} finally {
  await b.close();
  b.modelCache?.assertHealthy();
  process.exit(0);
}
