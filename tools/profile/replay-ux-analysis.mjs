import { LOG_SOURCE } from '../../extension/shared/messages.js';
import { generation, overlap } from './replay-timeline.mjs';

export const uxMetricKeys = ['initialViewportMs', 'scrollFollowMs', 'headingsAndLeadMs', 'shownMs', 'totalMs', 'firstParagraphMs'];
const coverageKeys = ['initial', 'scrolled', 'headingsAndLead', 'shown', 'all', 'paragraphs'];

export function analyzeUx({ startAt, observedAt, scroll, inventory, events }) {
  const elapsed = (at, origin = startAt) => Math.round(at - origin);
  const finished = (set, origin = startAt) => set.length && set.every((row) => row.completeAt !== null)
    ? Math.max(0, elapsed(Math.max(...set.map((row) => row.completeAt)), origin)) : null;
  const initial = inventory.filter((row) => row.initial === 'viewport');
  const shown = inventory.filter((row) => row.initial !== 'hidden');
  const hidden = inventory.filter((row) => row.initial === 'hidden');
  const scrolled = inventory.filter((row) => row.afterScroll);
  const collapsed = inventory.filter((row) => row.collapsed);
  const paragraphs = inventory.filter((row) => row.paragraph);
  const completedParagraphs = paragraphs.filter((row) => row.firstAt !== null);
  const counts = (set) => ({ translated: set.filter((row) => row.completeAt !== null).length, total: set.length });
  let translated = 0;
  const coverage = [{ ms: 0, translated: 0 }];
  for (const event of events) {
    translated += event.complete ? 1 : -1;
    const ms = elapsed(event.at);
    if (coverage.at(-1).ms === ms) coverage.at(-1).translated = translated;
    else coverage.push({ ms, translated });
  }
  if (coverage.at(-1).ms < elapsed(observedAt)) coverage.push({ ms: elapsed(observedAt), translated });
  return {
    initialViewportMs: finished(initial), scrollFollowMs: scroll ? finished(scrolled, scroll.at) : null,
    headingsAndLeadMs: finished(initial.filter((row) => row.lead)), shownMs: finished(shown), totalMs: finished(inventory),
    firstParagraphMs: completedParagraphs.length ? elapsed(Math.min(...completedParagraphs.map((row) => row.firstAt))) : null,
    counts: { all: counts(inventory), hidden: counts(hidden), collapsed: counts(collapsed), shown: counts(shown),
      initial: counts(initial), scrolled: counts(scrolled), headingsAndLead: counts(initial.filter((row) => row.lead)), paragraphs: counts(paragraphs) },
    coverage, scroll: scroll ? { ...scroll, ms: elapsed(scroll.at) } : null,
    incomplete: inventory.filter((row) => row.completeAt === null).map((row) => row.id),
  };
}

export function unchangedUxItems(inventory) {
  const items = inventory.filter((row) => row.completeAt !== null && row.evidence.output && row.rendered === row.source)
    .map(({ id, tag, source }) => ({ id, tag, source }));
  return { count: items.length, items };
}

export function dispatchDiagnostics(traces, startAt, observedAt, parallel) {
  const at = (event) => event.pageAt ?? Date.parse(event.time);
  const rel = (time) => +(time - startAt).toFixed(3);
  const generations = traces.filter((event) => event.source === LOG_SOURCE.model && event.startAt &&
    ['生成', '取り消し'].includes(event.event)).map((event) => ({ ...generation(event),
      entered: event.acquiredAt ?? generation(event).entered, end: event.releasedAt ?? generation(event).end,
      genMs: event.genMs ?? null, outcome: event.event }));
  const changes = new Map();
  for (const request of generations) {
    if (request.end <= request.entered) continue;
    changes.set(request.entered, (changes.get(request.entered) ?? 0) + 1);
    changes.set(request.end, (changes.get(request.end) ?? 0) - 1);
  }
  let occupied = 0;
  const occupancy = [[0, 0]];
  for (const [time, delta] of [...changes].sort(([left], [right]) => left - right)) {
    occupied += delta;
    if (delta) occupancy.push([rel(time), occupied]);
  }
  const sends = traces.filter((event) => event.event === '送信').sort((left, right) => at(left) - at(right));
  const replies = traces.filter((event) => ['受信', '取り消し済み', '失敗'].includes(event.event));
  const repliesById = Map.groupBy(replies, (reply) => reply.id);
  const generationsById = Map.groupBy(generations, (request) => request.id);
  const requests = sends.map((send) => ({ id: send.id, sentMs: rel(at(send)), lines: send.lines, screen: send.screen,
    replies: (repliesById.get(send.id) ?? []).map((reply) => ({ atMs: rel(at(reply)), elapsedMs: reply.ms, outcome: reply.event })),
    generations: (generationsById.get(send.id) ?? []).map((request) => ({ acquiredMs: rel(request.entered),
      releasedMs: rel(request.end), genMs: request.genMs, outcome: request.outcome })) }));
  const replyToNextSend = replies.filter((event) => event.pagePending > 0).map((reply) => {
    const next = sends.find((send) => at(send) >= at(reply));
    return { id: reply.id, at: rel(at(reply)), pending: reply.pagePending, next: next?.id ?? null,
      gapMs: next ? +(at(next) - at(reply)).toFixed(3) : null };
  });
  const selection = traces.filter((event) => event.event === '送信対象選択')
    .map((event) => ({ at: rel(event.selectedAt), ms: event.ms, pending: event.pending, selected: event.selected }));
  return { parallel, occupancy, ...overlap(generations.map(({ entered, end }) => ({ start: entered, end })), startAt, observedAt),
    requests, replyToNextSend, selection };
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return null;
  const upper = sorted.length >> 1;
  return sorted.length % 2 ? sorted[upper] : (sorted[upper - 1] + sorted[upper]) / 2;
}

function range(values) {
  const measured = values.filter(Number.isFinite);
  return { median: median(measured), min: measured.length ? Math.min(...measured) : null,
    max: measured.length ? Math.max(...measured) : null };
}

export function summarizeUxRuns(results) {
  return Object.fromEntries(Object.entries(results).map(([name, runs]) => [name, {
    rounds: runs.length, nativeCompleted: runs.filter((run) => run.native).length,
    coverage: runs.map((run) => run.ux.counts.all),
    ms: Object.fromEntries(uxMetricKeys.map((key, index) => {
      const values = runs.map((run) => run.ux[key]);
      const misses = runs.flatMap((run, round) => values[round] === null ? [{ round: round + 1,
        coverage: run.ux.counts[coverageKeys[index]], all: run.ux.counts.all,
        ...(key === 'scrollFollowMs' && !run.ux.scroll ? { notScrolled: true } : {}) }] : []);
      return [key, { reached: runs.length - misses.length, ...range(values), misses }];
    })),
    unchanged: range(runs.map((run) => run.quality.unchanged.count)),
    wallMedianMs: median(runs.map((run) => run.wallMs)),
  }]));
}
