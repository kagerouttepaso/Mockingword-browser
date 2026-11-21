import { MSG } from '../shared/messages.js';

export function createPdfBatchRequests(send) {
  let sequence = 0;
  const inflight = new Set();
  return {
    async translate(texts) {
      const id = ++sequence;
      inflight.add(id);
      try {
        const result = await send({ type: MSG.TRANSLATE_BATCH, texts, id });
        if (!result?.ok) throw new Error(result?.cancelled ? '翻訳が取り消されました' : result?.error ?? '翻訳できませんでした');
        return result.results;
      } finally {
        inflight.delete(id);
      }
    },
    cancel() {
      for (const id of inflight) send({ type: MSG.CANCEL, id }).catch(() => {});
      inflight.clear();
    },
  };
}
