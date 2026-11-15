// WORK の一時拡張へだけ追加する。モデルの語彙数と profile 版のイベントを保持する。
import { Wllama } from '../vendor/wllama/index.js';

globalThis.__plamoPerfEvents = [];
let instance = null;
let loadStarted = 0, loadTotalMs = null, nativeLoadMs = null;
const nativeLoad = Wllama.prototype.loadModel;
if (nativeLoad) Wllama.prototype.loadModel = async function (...args) {
  const start = performance.now();
  try { return await nativeLoad.apply(this, args); }
  finally { nativeLoadMs = performance.now() - start; }
};
const original = Wllama.prototype.loadModelFromUrl;
Wllama.prototype.loadModelFromUrl = async function (...args) {
  loadStarted = performance.now(); nativeLoadMs = null;
  const result = await original.apply(this, args);
  loadTotalMs = performance.now() - loadStarted;
  instance = this;
  return result;
};
globalThis.__plamoProfile = {
  metadata() {
    const info = instance?.getLoadedContextInfo();
    return { n_vocab: info?.n_vocab ?? null, context: info ?? null, multithread: instance?.isMultithread() ?? null,
      load: { totalMs: loadTotalMs, nativeLoadMs, localTransferMs: nativeLoadMs == null ? null : loadTotalMs - nativeLoadMs } };
  },
  reset() { globalThis.__plamoPerfEvents.length = 0; },
  drain() { return globalThis.__plamoPerfEvents.splice(0); },
};
