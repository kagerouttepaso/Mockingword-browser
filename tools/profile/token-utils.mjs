export function finalTokenSequence(chunks) {
  const valid = chunks.filter((chunk) => !chunk.progress && Array.isArray(chunk.tokens) && chunk.tokens.every(Number.isSafeInteger));
  const final = valid.filter((chunk) => chunk.final && chunk.tokens.length > 0).at(-1);
  if (final) return [...final.tokens];
  // 7d7f028のstreamではpartialが各token、finalが空配列。finalを重ねて足さない。
  const deltas = valid.filter((chunk) => !chunk.final).flatMap((chunk) => chunk.tokens);
  return deltas.length ? deltas : null;
}
export function compareTokenRuns(referenceRuns, candidateRuns) {
  const reference = referenceRuns.flatMap((run) => (run.tokenRounds ?? []).flat()), candidate = candidateRuns.flatMap((run) => (run.tokenRounds ?? []).flat());
  if (!reference.length && !candidate.length) return null;
  const known = new Map();
  for (const record of reference.filter((record) => record.tokens)) {
    const list = known.get(record.prompt) ?? []; list.push(record.tokens); known.set(record.prompt, list);
  }
  const novel = [];
  for (const record of candidate.filter((record) => record.tokens)) {
    const variants = known.get(record.prompt) ?? [];
    if (variants.some((tokens) => JSON.stringify(tokens) === JSON.stringify(record.tokens))) continue;
    const first = variants[0] ?? [];
    let index = 0; while (index < Math.min(first.length, record.tokens.length) && first[index] === record.tokens[index]) ++index;
    novel.push({ prompt: record.prompt, firstDifference: index, reference: first.slice(Math.max(0, index - 2), index + 4), candidate: record.tokens.slice(Math.max(0, index - 2), index + 4) });
  }
  return { referenceRecords: reference.length, candidateRecords: candidate.length,
    unavailable: [...reference, ...candidate].filter((record) => !record.tokens).length,
    countDifferences: [...reference, ...candidate].filter((record) => record.countDifference != null && record.countDifference !== 0).length, novel };
}
