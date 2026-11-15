// 新しいプロファイルと公開用の架空の文章だけで掲載素材を作る。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {generateIcons} from './icons.mjs';
import { fileURLToPath } from 'node:url';
import { launch, enableModelCache, message, tabIdOf, sleep } from './lib/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const images = path.join(root, 'store/images'); fs.mkdirSync(images, { recursive: true });
const svg = fs.readFileSync(path.join(root, 'artwork/icon.svg'), 'utf8');
let b;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Field Notes · A quieter way to travel</title><style>body{margin:0;color:#243345;background:#faf9f6;font:19px/1.75 Georgia,serif}header{padding:24px 80px;border-bottom:1px solid #dadbd7;letter-spacing:3px;font:15px sans-serif}main{max-width:920px;margin:55px auto}h1{font-size:44px;line-height:1.2}p{max-width:850px}small{font:13px sans-serif;color:#687668}</style><header>FIELD NOTES / WEEKEND JOURNEYS</header><main><small>TRAVEL · LOCAL STORIES</small><h1>A quieter way to explore a new city</h1><p>Start your morning with a walk through the old town. The streets are quiet before the shops open, and you can enjoy the architecture at your own pace.</p><p>Visit the local market for fresh fruit and a cup of coffee. Ask the shopkeepers about their favorite places nearby.</p><p>In the afternoon, follow the river to the public garden. Bring a book, find a shady bench, and leave some time without a plan.</p><p>A good journey is not measured by the number of places you visit. Sometimes the best memories come from a single conversation.</p></main></html>`);
});
await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
const sampleUrl = `http://127.0.0.1:${server.address().port}/`;
async function viewport(session) {
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, session);
  await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, session);
}
try {
  b = await launch({ port: 9352, width: 1320, height: 900 });
  const art = await b.open('about:blank', 100);
  await generateIcons(b,art.session);
  await enableModelCache(b, { models: ['0.8B'] });
  await b.eval(b.ext, `chrome.storage.sync.set({debugLog:false,mode:'both',theme:'light'})`);
  console.log('Preparing model');
  const warm = await message(b, { type: 'translate-one', text: 'Welcome to the city.' });
  if (!warm?.ok) throw new Error(JSON.stringify(warm));
  b.modelCache.assertUsed();
  const page = await b.open(sampleUrl); await viewport(page.session);
  const id = await tabIdOf(b, page.targetId);
  await message(b, { type: 'page-action', tabId: id, action: 'both' });
  if (!await b.waitFor(() => b.eval(page.session, `document.querySelectorAll('.plamo-tr').length>=5`), 90000)) throw new Error('Page translation did not complete');
  await sleep(800); await b.screenshot(page.session, path.join(images, '01-page-translation.png'));
  const text = await b.open(`chrome-extension://${b.extensionId}/ui/translate.html`); await viewport(text.session);
  await b.eval(text.session, `document.querySelector('#input').value=${JSON.stringify('The library opens at nine in the morning.\nPlease return your books before the end of the week.\nIf you need more time, you can renew them online.')};document.querySelector('#input').dispatchEvent(new Event('input'));document.querySelector('#translate').click()`);
  if (!await b.waitFor(() => b.eval(text.session, `!document.querySelector('#output').classList.contains('placeholder')&&!document.querySelector('#foot').textContent.includes('翻訳中')`), 90000)) throw new Error('Text translation did not complete');
  await b.eval(text.session, `document.activeElement?.blur()`);
  await b.screenshot(text.session, path.join(images, '02-text-translation.png'));
  const settings = await b.open(`chrome-extension://${b.extensionId}/ui/options.html`); await viewport(settings.session);
  await b.screenshot(settings.session, path.join(images, '03-settings.png'));
  await b.eval(settings.session, `(()=>{const s=document.querySelector('#theme');s.value='dark';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  if(!await b.waitFor(()=>b.eval(text.session,`document.documentElement.dataset.mwTheme==='dark'`),5000,100))throw new Error('Theme did not update');
  await b.send('Target.activateTarget', {targetId:text.targetId});
  await b.eval(text.session, `getComputedStyle(document.body).backgroundColor`);
  await b.screenshot(text.session,path.join(images,'04-text-dark.png'));
  // Optional promotional tile: artwork and text only; it does not impersonate a screenshot.
  await b.eval(art.session, `document.body.style.margin='0';document.body.innerHTML=${JSON.stringify(`<main style="width:440px;height:280px;box-sizing:border-box;background:#141a30;color:#e8eaf6;font-family:Segoe UI,Meiryo,sans-serif;padding:24px 30px;display:flex;align-items:center;gap:12px"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" style="width:132px;height:132px"><section><div style="font-size:29px;font-weight:700;letter-spacing:-1px">Mocking<span style="color:#FF8A65">word</span></div><p style="font-size:16px;line-height:1.7;color:#7fe0c8">ブラウザーの中で訳す。<br>文章を外へ送らない。</p><small style="color:#a9b8ff">Built with PLaMo</small></section></main>`)}`);
  await b.send('Emulation.setDeviceMetricsOverride', {width:440,height:280,deviceScaleFactor:1,mobile:false}, art.session);
  await b.screenshot(art.session, path.join(images, 'promo-440x280.png'));
  fs.copyFileSync(path.join(root,'extension/icons/icon128.png'),path.join(images,'store-icon-128.png'));
  const version = await b.send('Browser.getVersion');
  console.log(JSON.stringify({browser:version.product,extension:b.extensionId,shots:images}));
} finally { if(b){await b.send('Browser.close').catch(()=>{});await b.close()} server.closeAllConnections();await new Promise(r=>server.close(r)); }
