// 通しの試験・速さの測定の共通部分。Chromiumブラウザーを新しい一時プロファイルで起動し、拡張機能を読み込み、DevTools（CDP）で操作する。
// 毎回新しいプロファイルを使う（使い回すと前回のService Workerが残り、読み込み直しても起動しなかった。2026-11-09）。
// そのため最初の翻訳でモデル（0.8Bで約570MB）を Hugging Face から取得する（約35秒）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

export const EXTENSION = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../extension');
const BROWSER = process.env.BROWSER ?? process.env.BRAVE ?? 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9350, extension = EXTENSION, width = 1200, height = 900, extensionWaitMs = 1500 } = {}) {
  const launchStarted = performance.now();
  // 実行中の別試験のCDPへ接続せず、新しいプロファイルの起動を確認できるようにする。
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`CDP ポート ${port} は使用中か利用不能です。実行中の試験を終了するか port を変更してください`)));
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => probe.close(resolve));
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-test-'));
  const proc = spawn(BROWSER, [
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, `--load-extension=${extension}`, `--disable-extensions-except=${extension}`,
    '--no-first-run', '--no-default-browser-check', `--window-size=${width},${height}`,
    // 試験の窓がほかの窓の後ろに隠れても、描画（requestAnimationFrame）とタイマーを止めない。止まると pdf.js がページを
    // 描き終えず、試験の結果が利用者の画面の使い方に左右された（2026-11-17、PDF翻訳のページの試験で確かめた）
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let version;
  for (let i = 0; i < 60 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(300); }
  }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const browserConnected = performance.now();
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  // 試験の通信監視がブラウザーを停止した場合も、保留中の評価を失敗として返す。
  ws.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('ブラウザーの CDP 接続が閉じました'));
    pending.clear();
  });
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method) for (const l of listeners) l(m);
  });

  const b = {
    profile,
    /** CDP の命令を送る。 */
    send(method, params = {}, sessionId) {
      if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('試験用ブラウザーの接続は閉じています'));
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener) {
      listeners.push(listener);
      return () => { const index = listeners.indexOf(listener); if (index >= 0) listeners.splice(index, 1); };
    },
    /** 式を評価して値を返す（Promise は待つ）。contextId を渡すと、その世界（拡張機能の世界など）で評価する。 */
    async eval(sessionId, expression, contextId) {
      const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
      return r.result.value;
    },
    async targets() {
      return (await b.send('Target.getTargets')).targetInfos;
    },
    async attach(targetId) {
      return (await b.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    },
    /** 新しいタブで開いて、{ targetId, session } を返す。 */
    async open(url, wait = 1500) {
      const { targetId } = await b.send('Target.createTarget', { url });
      const session = await b.attach(targetId);
      await sleep(wait);
      return { targetId, session };
    },
    async waitFor(fn, ms, every = 500) {
      const end = Date.now() + ms;
      let v;
      while (Date.now() < end) {
        v = await fn().catch(() => null);
        if (v) return v;
        await sleep(every);
      }
      return v;
    },
    async screenshot(sessionId, file) {
      const { data } = await b.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async close() {
      proc.kill();
      await sleep(1000);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    },
  };

  // 大量の計測用。従来のcloseは保ち、終了イベントと削除可能な状態を待つ入口を追加する。
  b.closeFast = async () => {
    const ended = () => proc.exitCode !== null || proc.signalCode !== null;
    const exited = ended() ? Promise.resolve() : new Promise((resolve) => proc.once('exit', resolve));
    const bounded = async (promise, ms) => {
      let timer;
      try { await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]); }
      finally { clearTimeout(timer); }
    };
    await bounded(Promise.resolve().then(() => b.send('Browser.close')).catch(() => {}), 2000);
    if (!ended()) await bounded(exited, 2000);
    if (!ended()) { proc.kill(); await bounded(exited, 2000); }
    const deadline = Date.now() + 5000;
    while (fs.existsSync(profile)) {
      const resolved = fs.realpathSync(profile), temporaryRoot = fs.realpathSync(os.tmpdir());
      if (path.dirname(resolved).toLowerCase() !== temporaryRoot.toLowerCase()) throw new Error('一時プロファイルの削除対象がTempの直下にありません');
      try { fs.rmSync(resolved, { recursive: true, force: true }); }
      catch (error) { if (Date.now() >= deadline) throw error; await sleep(100); }
    }
  };

  // 拡張機能のService Workerを待ち、ID と、リクエストを送るための拡張機能のページ（設定画面）を用意する。
  const sw = await b.waitFor(async () => (await b.targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/background/main.js')), 20000, 300);
  if (!sw) throw new Error('拡張機能のService Workerが起動しませんでした（manifest の誤りなど）');
  b.extensionId = new URL(sw.url).host;
  b.ext = (await b.open(`chrome-extension://${b.extensionId}/ui/options.html`, extensionWaitMs)).session;
  await b.waitFor(() => b.eval(b.ext, `typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage`), 10000, 200);
  if (extensionWaitMs === 0 && !await b.waitFor(() => b.eval(b.ext, `chrome.storage.sync.get('settingsVersion').then(value => !!value.settingsVersion)`), 10000, 100)) throw new Error('拡張機能の初期設定が完了しませんでした');
  b.launchTimings = { browserMs: browserConnected - launchStarted, extensionMs: performance.now() - browserConnected, totalMs: performance.now() - launchStarted };
  return b;
}

/** 拡張機能のリクエストを送る（設定画面から chrome.runtime.sendMessage）。 */
export function message(b, msg) {
  return b.eval(b.ext, `chrome.runtime.sendMessage(${JSON.stringify(msg)})`);
}

/** タブを前面にして、拡張機能から見たタブの番号を返す（拡張機能に tabs の権限が無く、URL で探せないため）。 */
export async function tabIdOf(b, targetId) {
  await b.send('Target.activateTarget', { targetId });
  await sleep(300);
  return b.eval(b.ext, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0].id)`);
}

/** Service Workerの pages.js の sendToPage と同じ手順で、ページへ差し込んでから指示を送る（右クリックのメニューの代わり）。 */
export function toPage(b, tabId, msg, frameId = 0) {
  return b.eval(b.ext, `(async () => {
    const target = { tabId: ${tabId}, frameIds: [${frameId}] };
    await chrome.scripting.insertCSS({ target, files: ['shared/theme.css', 'page/page.css'] });
    await chrome.scripting.executeScript({ target, files: ['page/loader.js'] });
    return chrome.tabs.sendMessage(${tabId}, ${JSON.stringify(msg)}, { frameId: ${frameId} });
  })()`);
}

/** マウスでなぞって選ぶ（要素の左端から dx1〜dx2 の位置）。 */
export async function dragSelect(b, session, selector, dx1, dx2) {
  const r = await b.eval(session, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x, y: r.y + r.height / 2, w: r.width }; })()`);
  const x0 = r.x + dx1;
  const x1 = r.x + Math.min(dx2, r.w - 2);
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: r.y, button: 'left', clickCount: 1 }, session);
  for (let i = 1; i <= 10; i++) await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 10, y: r.y, button: 'left', buttons: 1 }, session);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: r.y, button: 'left', clickCount: 1 }, session);
  await sleep(400);
}

export async function click(b, session, x, y, button = 'left') {
  await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }, session);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }, session);
}

/** 結果を集めて、最後に一覧で出す。 */
export function reporter() {
  const results = [];
  return {
    check(name, ok, detail = '') {
      results.push({ name, ok: !!ok, detail });
      console.log(`${ok ? '○' : '×'} ${name}${detail ? '：' + detail : ''}`);
    },
    summary() {
      const ng = results.filter((r) => !r.ok);
      console.log(`\n${results.length - ng.length}/${results.length} 件が通りました${ng.length ? '。通らなかったもの：' + ng.map((r) => r.name).join('、') : ''}`);
      return ng.length === 0;
    },
  };
}

// 新しいプロファイルを維持したまま、試験時だけ固定モデルを共有キャッシュから供給する。
export { enableModelCache } from './model-cache-cdp.mjs';
