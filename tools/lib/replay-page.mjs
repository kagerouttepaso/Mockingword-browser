import { partHeaders } from './mhtml.mjs';
import { sleep, tabIdOf } from './browser.mjs';

export async function openReplayPage(browser, fixture, { viewport, readyDelay, onConsole = () => {} } = {}) {
  const { targetId, session } = await browser.open('about:blank', 0);
  const contexts = new Map();
  const stopListening = browser.on((event) => {
    if (event.sessionId !== session) return;
    if (event.method === 'Runtime.executionContextCreated') contexts.set(event.params.context.id, event.params.context);
    if (event.method === 'Runtime.executionContextDestroyed') contexts.delete(event.params.executionContextId);
    if (event.method === 'Runtime.executionContextsCleared') contexts.clear();
    if (event.method === 'Runtime.consoleAPICalled') {
      onConsole({ t: event.params.timestamp, text: event.params.args.map((arg) => arg.value ?? '').join(' ') });
    }
    if (event.method !== 'Fetch.requestPaused') return;
    const { request, requestId } = event.params;
    const part = fixture.parts.get(request.url.split('#')[0]);
    const [method, params] = request.url.startsWith('chrome-extension://') ? ['continueRequest', {}]
      : part ? ['fulfillRequest', { responseCode: 200, responseHeaders: partHeaders(part), body: part.body.toString('base64') }]
        : ['failRequest', { errorReason: 'BlockedByClient' }];
    browser.send(`Fetch.${method}`, { requestId, ...params }, session).catch(() => {});
  });
  const close = async () => {
    stopListening();
    await browser.send('Target.closeTarget', { targetId });
  };
  try {
    if (viewport) await browser.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, session);
    await browser.send('Runtime.enable', {}, session);
    await browser.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, session);
    const navigation = await browser.send('Page.navigate', { url: fixture.main }, session);
    if (navigation.errorText) throw new Error(navigation.errorText);
    if (readyDelay !== undefined) await sleep(readyDelay);
    else {
      if (!await browser.waitFor(() => browser.eval(session, 'document.readyState === "complete" && !!document.body'), 15000, 80)) {
        throw new Error('保存ページを読み込めませんでした');
      }
      await browser.eval(session, 'Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2500))]).then(() => true)');
    }
    const tabId = await tabIdOf(browser, targetId);
    return { targetId, session, tabId, close, contexts, frameId: navigation.frameId };
  } catch (error) {
    await close();
    throw error;
  }
}

export function readMockingwordPairs(browser, session) {
  return browser.eval(session, `[...document.querySelectorAll('.plamo-tr')].map((tr) => {
    let el = tr.parentElement;
    while (el && !el.querySelector('[data-plamo-orig]')) el = el.parentElement;
    const source = el ? [...el.querySelectorAll('[data-plamo-orig]')].filter((w) => !w.closest('.plamo-tr')).map((w) => w.textContent).join('').replace(/\\s+/g, ' ').trim() : '';
    return { source, translation: tr.textContent.replace(/\\s+/g, ' ').trim() };
  })`);
}
