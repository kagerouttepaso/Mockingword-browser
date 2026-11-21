import { LOG_SOURCE } from '../../extension/shared/messages.js';
import { generation, overlap } from './replay-timeline.mjs';

export const uxMetricKeys = ['initialViewportMs', 'scrollFollowMs', 'headingsAndLeadMs', 'shownMs', 'totalMs', 'firstParagraphMs'];

export function analyzeUx({ startAt, observedAt, scroll, inventory, events }) {
  const elapsed = (at, origin = startAt) => Math.round(at - origin);
  const finished = (set, origin = startAt) => set.length && set.every((row) => row.completeAt !== null)
    ? Math.max(0, elapsed(Math.max(...set.map((row) => row.completeAt)), origin)) : null;
  const initial = inventory.filter((row) => row.initial === 'viewport');
  const shown = inventory.filter((row) => row.initial !== 'hidden');
  const hidden = inventory.filter((row) => row.initial === 'hidden');
  const scrolled = inventory.filter((row) => row.afterScroll);
  const collapsed = inventory.filter((row) => row.collapsed);
  const completedParagraphs = inventory.filter((row) => row.paragraph && row.firstAt !== null);
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
      initial: counts(initial), scrolled: counts(scrolled), headingsAndLead: counts(initial.filter((row) => row.lead)) },
    coverage, scroll: scroll ? { ...scroll, ms: elapsed(scroll.at) } : null,
    unchanged: inventory.filter((row) => row.rendered === row.source).map((row) => row.id),
    incomplete: inventory.filter((row) => row.completeAt === null).map((row) => row.id),
  };
}

export function dispatchDiagnostics(traces, startAt, observedAt, parallel) {
  const at = (event) => event.pageAt ?? Date.parse(event.time);
  const rel = (time) => +(time - startAt).toFixed(3);
  const generations = traces.filter((event) => event.source === LOG_SOURCE.model && event.startAt &&
    ['生成', '取り消し'].includes(event.event)).map((event) => ({ ...generation(event),
      entered: event.acquiredAt ?? generation(event).entered, end: event.releasedAt ?? generation(event).end }));
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
  const replyToNextSend = replies.filter((event) => event.pagePending > 0).map((reply) => {
    const next = sends.find((send) => at(send) >= at(reply));
    return { id: reply.id, at: rel(at(reply)), pending: reply.pagePending, next: next?.id ?? null,
      gapMs: next ? +(at(next) - at(reply)).toFixed(3) : null };
  });
  const selection = traces.filter((event) => event.event === '送信対象選択')
    .map((event) => ({ at: rel(event.selectedAt), ms: event.ms, pending: event.pending, selected: event.selected }));
  return { parallel, occupancy, ...overlap(generations.map(({ entered, end }) => ({ start: entered, end })), startAt, observedAt),
    replyToNextSend, selection };
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (!sorted.length) return null;
  const upper = sorted.length >> 1;
  return sorted.length % 2 ? sorted[upper] : (sorted[upper - 1] + sorted[upper]) / 2;
}
