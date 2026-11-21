// CDP の専用セッションで固定モデルURLをローカルへ差し替える。製品コードと manifest は変更しない。
import { prepareModelCache, startModelServer, DEFAULT_EXTENSION } from './model-cache.mjs';

const TARGET_TYPES = ['page', 'iframe', 'worker', 'shared_worker', 'service_worker', 'background_page', 'other'];
export async function installModelInterception(b, prepared, { log = console.log, allowAbortedIntercept = false } = {}) {
  const local = await startModelServer(prepared.entries);
  // 製品が参照する固定URLだけを対象とし、試験ページ自身の通信とHTTPキャッシュを保つ。
  const modelUrls = (prepared.catalog ?? prepared.entries).flatMap((model) => [model.url, model.rawUrl]);
  const modelTraffic = (url) => modelUrls.some((prefix) => url?.startsWith(prefix));
  const patterns = modelUrls.map((url) => ({ urlPattern: url.replace(/[\\*?]/g, '\\$&') + '*', requestStage: 'Request' }));
  const owners = new Map(), sessions = new Map(), pending = new Set(), watches = new Map(), requests = new Map();
  const audit = { cacheRoot: prepared.root, downloadedBytes: prepared.entries.reduce((sum, entry) => sum + entry.downloadedBytes, 0),
    models: prepared.entries.map(({ id, url, size, sha256, hashBasis }) => ({ id, url, size, sha256, hashBasis })), targets: [], intercepted: [], failures: [] };
  let failure = null, closing = false, closePromise;
  const originalClose = b.close.bind(b);
  const controller = {
    assertHealthy() { if (failure) throw failure; },
    assertUsed() {
      this.assertHealthy();
      if (!local.stats.dataRequests || !local.stats.dataBytes) {
        fail(new Error('共有モデルの本体供給を確認できません。横取り設定を確認してください'));
        this.assertHealthy();
      }
    },
    snapshot() { return { ...audit, local: { ...local.stats, origin: local.origin }, healthy: !failure }; },
    async settle() { while (pending.size) await Promise.allSettled([...pending]); this.assertHealthy(); },
  };
  b.modelCache = controller;
  b.close = () => closePromise ??= (async () => {
    closing = true;
    for (const timer of watches.values()) clearTimeout(timer);
    watches.clear();
    try { await originalClose(); }
    finally {
      await local.close();
      log(`共有モデル供給: 外部取得 ${audit.downloadedBytes} bytes、ローカル本体 ${local.stats.dataRequests} 回・${local.stats.dataBytes} bytes、横取り ${audit.intercepted.length} 回`);
    }
  })();
  function fail(error) {
    if (closing || failure) return;
    failure = error instanceof Error ? error : new Error(String(error));
    audit.failures.push(failure.message);
    console.error(`共有モデル供給で停止: ${failure.message}`);
    // 横取り漏れを外部ダウンロードへフォールバックさせない。保留CDP命令も close で失敗させる。
    void b.close().catch((e) => console.error(`共有モデル供給の終了処理: ${e.message}`));
  }
  function track(promise) {
    const guarded = promise.catch(fail).finally(() => pending.delete(guarded));
    pending.add(guarded);
    return guarded;
  }
  const belongsToExtension = (url) => url?.startsWith(`chrome-extension://${b.extensionId}/`) || url?.startsWith(`blob:chrome-extension://${b.extensionId}/`);
  function watchTarget(info) {
    if (closing || !belongsToExtension(info.url) || !TARGET_TYPES.includes(info.type) || sessions.get(owners.get(info.targetId))?.ready || watches.has(info.targetId)) return;
    watches.set(info.targetId, setTimeout(() => {
      watches.delete(info.targetId);
      if (!closing && !sessions.get(owners.get(info.targetId))?.ready) fail(new Error(`拡張ターゲットへの横取りが未設定です: ${info.type} ${info.url}`));
    }, 5000));
  }
  async function setupTarget({ sessionId, targetInfo, waitingForDebugger }) {
    if (closing) return;
    const existing = owners.get(targetInfo.targetId);
    if (existing) {
      // 台本の手動 attach と共存する。Fetch はターゲットごとに一つの専用セッションで使う。
      if (waitingForDebugger) { await sessions.get(existing)?.setup; await b.send('Runtime.runIfWaitingForDebugger', {}, sessionId); }
      return;
    }
    owners.set(targetInfo.targetId, sessionId);
    const entry = { targetInfo, ready: false, setup: null };
    sessions.set(sessionId, entry);
    entry.setup = (async () => {
      await b.send('Network.enable', {}, sessionId);
      let interception = 'Fetch';
      try { await b.send('Fetch.enable', { patterns }, sessionId); }
      catch (e) {
        if (!String(e.message).includes('-32601') || !String(e.message).includes('Fetch.enable')) throw e;
        // 一部WorkerはFetchドメインを持たない。同じ固定URLだけを実行前のfetchフックで差し替える。
        interception = 'Runtime.fetch';
        await b.send('Runtime.enable', {}, sessionId);
        await b.send('Runtime.addBinding', { name: '__plamoModelCacheEvent' }, sessionId);
        const routes = Object.fromEntries([...local.urls].map(([url, route]) => [url, route.localUrl]));
        const hook = `(() => {
          if (globalThis.__plamoModelFetchInstalled) return true;
          if (typeof globalThis.fetch !== 'function') return false;
          const original = globalThis.fetch.bind(globalThis), routes = ${JSON.stringify(routes)}, prefixes = ${JSON.stringify(modelUrls)};
          globalThis.fetch = async (input, init) => {
            const url = input instanceof Request ? input.url : String(input);
            if (!prefixes.some(prefix => url.startsWith(prefix))) return original(input, init);
            const local = routes[url];
            if (!local) { __plamoModelCacheEvent(JSON.stringify({ kind: 'error', url })); throw new TypeError('共有モデルに対応しないURL: ' + url); }
            __plamoModelCacheEvent(JSON.stringify({ kind: 'rewrite', url, method: init?.method ?? (input instanceof Request ? input.method : 'GET') }));
            const response = await (input instanceof Request ? original(new Request(local, input), init) : original(local, init));
            try { Object.defineProperty(response, 'url', { value: url }); } catch {}
            return response;
          };
          globalThis.__plamoModelFetchInstalled = true; return true;
        })()`;
        const result = await b.send('Runtime.evaluate', { expression: hook, returnByValue: true }, sessionId);
        if (result.exceptionDetails || result.result?.value !== true) throw new Error(`Fetch非対応ターゲットへ代替供給を設定できません: ${targetInfo.type}`);
        log(`共有モデル: ${targetInfo.type} はFetch非対応のため実行前のfetchフックを使用`);
      }
      // offscreen と、その子の OPFS／pthread Worker まで、実行再開前に設定する。
      try { await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter }, sessionId); }
      catch (e) { if (!String(e.message).includes('-32601') || !String(e.message).includes('Target.setAutoAttach')) throw e; }
      entry.ready = true;
      audit.targets.push({ type: targetInfo.type, url: targetInfo.url, interception });
      clearTimeout(watches.get(targetInfo.targetId)); watches.delete(targetInfo.targetId);
      await b.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    })();
    await entry.setup;
  }
  async function paused(event) {
    const { requestId, request, networkId } = event.params;
    const route = local.urls.get(request.url);
    if (!route || !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      await b.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, event.sessionId);
      throw new Error(`共有キャッシュに対応しないモデル要求を遮断しました: ${request.method} ${request.url}`);
    }
    // Worker の要求が親ターゲットにも通知される場合を、Network ID で対応付ける。
    if (networkId) requests.set(networkId, { url: request.url, intercepted: true });
    audit.intercepted.push({ model: route.entry.id, kind: route.kind, method: request.method, url: request.url });
    await b.send('Fetch.continueRequest', { requestId, url: route.localUrl }, event.sessionId);
  }
  function eventListener(event) {
    if (closing) return;
    if (event.method === 'Target.attachedToTarget') { track(setupTarget(event.params)); return; }
    if (event.method === 'Target.targetCreated' || event.method === 'Target.targetInfoChanged') { watchTarget(event.params.targetInfo); return; }
    if (event.method === 'Target.targetDestroyed') {
      const target = event.params.targetId;
      clearTimeout(watches.get(target)); watches.delete(target);
      sessions.delete(owners.get(target)); owners.delete(target); return;
    }
    if (event.method === 'Target.detachedFromTarget') {
      const entry = sessions.get(event.params.sessionId);
      if (entry) { owners.delete(entry.targetInfo.targetId); sessions.delete(event.params.sessionId); }
      return;
    }
    if (!sessions.has(event.sessionId)) return;
    if (event.method === 'Runtime.bindingCalled' && event.params.name === '__plamoModelCacheEvent') {
      try {
        const value = JSON.parse(event.params.payload), route = local.urls.get(value.url);
        if (value.kind !== 'rewrite' || !route) throw new Error(`共有キャッシュに対応しないモデル要求を遮断しました: ${value.url}`);
        audit.intercepted.push({ model: route.entry.id, kind: route.kind, method: value.method, url: value.url, interception: 'Runtime.fetch' });
      } catch (e) { fail(e); }
      return;
    }
    if (event.method === 'Fetch.requestPaused') { track(paused(event)); return; }
    const key = event.params.requestId;
    const isLocalModel = (url) => [...local.urls.values()].some((route) => route.localUrl === url);
    if (event.method === 'Network.requestWillBeSent' && (modelTraffic(event.params.request.url) || isLocalModel(event.params.request.url))) {
      const previous = requests.get(key);
      requests.set(key, { url: event.params.request.url, intercepted: isLocalModel(event.params.request.url) || previous?.intercepted || false });
    }
    if (event.method === 'Network.responseReceived' && (modelTraffic(event.params.response.url) || requests.has(key))) {
      const request = requests.get(key), response = event.params.response;
      if (!request?.intercepted && !isLocalModel(response.url)) { fail(new Error(`横取りされていないモデル通信を検出しました: ${response.url}`)); return; }
      const ip = response.remoteIPAddress?.replace(/^\[|\]$/g, '');
      if (ip && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) fail(new Error(`モデルがローカル以外から返りました: ${ip} ${request.url}`));
    }
    if (event.method === 'Network.loadingFailed' && requests.has(key)) {
      const request = requests.get(key);
      if (!(allowAbortedIntercept && request.intercepted && event.params.errorText === 'net::ERR_ABORTED')) {
        fail(new Error(`ローカルモデルの読込みに失敗しました: ${event.params.errorText} ${request.url}`));
      }
    }
  }
  const filter = [...TARGET_TYPES.map((type) => ({ type })), { exclude: true }];
  b.on(eventListener);
  const originalEval = b.eval.bind(b);
  b.eval = async (...args) => {
    controller.assertHealthy();
    try { const result = await originalEval(...args); controller.assertHealthy(); return result; }
    catch (e) { controller.assertHealthy(); throw e; }
  };
  try {
    await b.send('Target.setDiscoverTargets', { discover: true });
    await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter });
    await controller.settle();
    // 自動 attach の対象から外れた既存ターゲットも、モデル読込み前に確認する。
    for (const info of await b.targets()) {
      if (!TARGET_TYPES.includes(info.type)) continue;
      if (!owners.has(info.targetId)) { const sessionId = await b.attach(info.targetId); if (!owners.has(info.targetId)) await setupTarget({ sessionId, targetInfo: info, waitingForDebugger: false }); }
    }
    await controller.settle();
    log(`共有モデル横取りを設定済み: ${prepared.entries.map((entry) => entry.id).join(', ')}（offscreen・子Workerも自動設定）`);
    return controller;
  } catch (e) { fail(e); throw e; }
}
export async function enableModelCache(b, options = {}) {
  try {
    const prepared = await prepareModelCache({ extension: options.extension ?? DEFAULT_EXTENSION, ...options });
    return await installModelInterception(b, prepared, options);
  } catch (e) {
    console.error(`共有モデルの準備に失敗しました: ${e.message}`);
    if (!b.modelCache) b.modelCache = { assertHealthy() { throw e; }, assertUsed() { throw e; }, snapshot() { return { healthy: false, failures: [e.message] }; } };
    throw e;
  }
}
