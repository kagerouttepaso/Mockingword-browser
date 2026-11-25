import { MSG, PDF_BATCH_PORT } from '../shared/messages.js';

export function createPdfBatchRequests(connect) {
  let sequence = 0;
  const inflight = new Set();
  return {
    /** texts を訳文の言語 target へ訳す。 */
    translate(texts, target, onPartial) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const port = connect({ name: PDF_BATCH_PORT });
        const finish = (result) => {
          if (!inflight.delete(finish)) return;
          port.disconnect();
          if (result?.ok) resolve(result.results);
          else reject(new Error(result?.cancelled ? '翻訳が取り消されました' : result?.error ?? '翻訳の接続が切れました'));
        };
        inflight.add(finish);
        port.onDisconnect.addListener(() => finish());
        port.onMessage.addListener((message) => {
          if (!inflight.has(finish)) return;
          if (message.type === MSG.SHOW_PARTIAL) onPartial?.(message.lines);
          else finish(message);
        });
        try {
          port.postMessage({ type: MSG.TRANSLATE_BATCH, texts, id, target });
        } catch (e) {
          finish({ error: e.message });
        }
      });
    },
    cancel() {
      for (const finish of inflight) finish({ cancelled: true });
    },
  };
}
