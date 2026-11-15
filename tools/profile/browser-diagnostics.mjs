// モデル供給のautoAttachと同じCDP接続を使い、Worker再開前にログを有効化する。
export const DIAGNOSTIC_METHODS = new Set(['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded', 'Inspector.targetCrashed']);
const targetTypes = ['page', 'iframe', 'worker', 'shared_worker', 'service_worker', 'background_page', 'other'];
const filter = [...targetTypes.map((type) => ({ type })), { exclude: true }];
export function diagnosticMessage(event) {
  const p = event.params ?? {};
  const textOf = (arg) => {
    if (typeof arg?.value === 'string') return arg.value;
    if (arg?.value !== undefined) return JSON.stringify(arg.value);
    const preview = arg?.preview?.properties?.map((property) => `${property.name}: ${property.value ?? property.valuePreview?.description ?? property.type}`).join(', ');
    return [arg?.description ?? arg?.unserializableValue ?? arg?.type ?? '', preview].filter(Boolean).join(' ');
  };
  let level, text;
  if (event.method === 'Runtime.consoleAPICalled') { level = p.type; text = (p.args ?? []).map(textOf).join(' '); }
  else if (event.method === 'Log.entryAdded') { level = p.entry?.level; text = [p.entry?.text, ...(p.entry?.args ?? []).map(textOf)].filter(Boolean).join(' '); }
  else if (event.method === 'Runtime.exceptionThrown') { level = 'error'; text = p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? ''; }
  else if (event.method === 'Inspector.targetCrashed') { level = 'error'; text = 'ターゲットがクラッシュしました'; }
  else return null;
  return { level, text, method: event.method, target: event.target ?? null, sessionId: event.sessionId ?? null,
    timestamp: p.timestamp ?? p.entry?.timestamp ?? event.receivedAt ?? null };
}
export function importantDiagnostic(event) {
  const message = diagnosticMessage(event);
  return message && (['error', 'warning', 'warn', 'assert'].includes(message.level) || /ggml|webgpu|wgsl/i.test(message.text)) ? message : null;
}
export async function installBrowserDiagnostics(b, write) {
  const sessions = new Map(), ready = new Map(), failures = [], counts = {}, important = [], seen = new Set();
  const send = b.send.bind(b); let closing = false;
  function save(event) {
    const record = { ...event, receivedAt: Date.now(), target: sessions.get(event.sessionId) ?? null };
    write(record); counts[event.method] = (counts[event.method] ?? 0) + 1;
    const message = importantDiagnostic(record);
    const key = message && JSON.stringify([message.target?.targetId, message.level, message.text]);
    if (message && !seen.has(key) && important.length < 10) { seen.add(key); important.push(message); }
  }
  function setup(sessionId, targetInfo) {
    if (ready.has(sessionId)) return ready.get(sessionId);
    sessions.set(sessionId, targetInfo);
    const task = (async () => {
      await send('Runtime.enable', {}, sessionId);
      try { await send('Log.enable', {}, sessionId); }
      catch (error) {
        // WorkerによってはLogドメインがない。Runtime.consoleAPICalledは引き続き収集する。
        if (!String(error.message).includes('-32601')) throw error;
        write({ method: 'Profile.logDomainUnavailable', sessionId, target: targetInfo, error: error.message });
      }
      try { await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter }, sessionId); }
      catch (error) { if (!String(error.message).includes('-32601')) throw error; }
    })().catch((error) => {
      if (!closing) { failures.push({ sessionId, target: targetInfo, error: error.message }); write({ method: 'Profile.logSetupFailed', sessionId, target: targetInfo, error: error.message }); }
    });
    ready.set(sessionId, task); return task;
  }
  const wrappedSend = async (method, params = {}, sessionId) => {
    // モデルキャッシュ側が再開する場合も、Runtime/Log設定の終了を先に待つ。
    if (method === 'Runtime.runIfWaitingForDebugger') await ready.get(sessionId);
    return send(method, params, sessionId);
  };
  b.send = wrappedSend;
  const listener = (event) => {
    if (closing) return;
    if (event.method === 'Target.attachedToTarget') { void setup(event.params.sessionId, event.params.targetInfo); return; }
    if (DIAGNOSTIC_METHODS.has(event.method)) save(event);
  };
  const unsubscribe = b.on(listener);
  const controller = {
    async settle() { await Promise.all([...ready.values()]); },
    snapshot() { return { targets: [...sessions.entries()].map(([sessionId, target]) => ({ sessionId, ...target })), counts: { ...counts }, important: [...important], failures: [...failures] }; },
    stop() { closing = true; unsubscribe?.(); if (b.send === wrappedSend) b.send = send; },
  };
  // 起動済みのoffscreen等を含める。今後のターゲットはモデル供給のbrowser autoAttachが通知する。
  try {
    for (const info of await b.targets()) if (targetTypes.includes(info.type)) {
      const sessionId = await b.attach(info.targetId); await setup(sessionId, info);
    }
  } catch (error) { controller.stop(); throw error; }
  return controller;
}
