// 一時拡張の開発用。SDKのstream deltaとfinalを区別してtokenの重複を避ける。
import { Wllama } from '../vendor/wllama/index.js';
import { finalTokenSequence } from './profile-token-utils.mjs';
const records = [];
const original = Wllama.prototype.createCompletion;
Wllama.prototype.createCompletion = async function (options) {
  const record = { prompt: options.prompt, chunks: [], tokens: null, completionTokens: null, unavailable: '__verbose.tokensがありません' };
  try {
    return await original.call(this, { ...options, onData: (chunk) => {
      const tokens = chunk.__verbose?.tokens;
      const final = chunk.choices?.some((choice) => choice.finish_reason != null) || chunk.usage?.completion_tokens != null;
      record.completionTokens = chunk.usage?.completion_tokens ?? record.completionTokens;
      if (Array.isArray(tokens)) {
        record.chunks.push({ final: !!final, progress: !!chunk.prompt_progress, tokens });
      }
      return options.onData?.(chunk);
    } });
  } finally {
    record.tokens = finalTokenSequence(record.chunks);
    record.selection = record.chunks.some((chunk) => chunk.final && chunk.tokens.length) ? 'final' : 'stream-delta';
    record.countDifference = record.tokens && record.completionTokens != null ? record.completionTokens - record.tokens.length : null;
    if (record.tokens) record.unavailable = null;
    records.push(record);
  }
};
globalThis.__plamoTokenCollector = { reset() { records.length = 0; }, drain() { return records.splice(0); } };
