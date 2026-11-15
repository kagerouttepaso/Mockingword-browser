// tools/profile.mjs が WORK のコピーへ追加する。SAMPLE はコピー内の tune.js から共有する。
import { complete, status } from '../core/engine.js';
import { settings } from './config.js';
import { SAMPLE } from './tune.js';

globalThis.__plamoHarness = {
  async prepare() {
    const options = { ...(await settings()), debugLog: false, requestId: undefined };
    const start = performance.now();
    await complete('Warm up the model.', options);
    return { options, status: await status(), loadMs: performance.now() - start };
  },
  async round() {
    const options = { ...(await settings()), debugLog: false, requestId: undefined };
    const queue = SAMPLE.map((text, index) => ({ text, index }));
    const results = [];
    let tokens = 0;
    let tokenFallback = false;
    let firstMs = 0;
    const start = performance.now();
    const worker = async () => {
      while (queue.length) {
        const item = queue.shift();
        const response = await complete(item.text, options);
        firstMs ||= performance.now() - start;
        tokenFallback ||= response.tokens == null;
        tokens += response.tokens ?? response.text.length;
        results[item.index] = { text: response.text, tokens: response.tokens, cut: response.cut };
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.parallel, SAMPLE.length) }, worker));
    return { ms: performance.now() - start, firstMs, tokens, tokenFallback, results };
  },
  async quality() {
    const options = { ...(await settings()), debugLog: false, requestId: undefined };
    return complete('Please read the <a1>installation guide</a1> before continuing.\nContact <a2>support</a2> if the problem continues.', options);
  },
};
