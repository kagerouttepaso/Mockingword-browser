import { chunk, headingLike, markLeads, READING_TIER, shortItem } from '../shared/text.js';

export function paragraphsByPage(paras) {
  const pages = new Map();
  for (const para of paras) {
    if (!pages.has(para.page)) pages.set(para.page, []);
    pages.get(para.page).push(para);
  }
  return pages;
}

function readingOrder(paras) {
  const weights = new Map();
  for (const para of paras) {
    const size = Math.round(para.size);
    weights.set(size, (weights.get(size) ?? 0) + para.plain.length);
  }
  const base = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0];
  const kinds = markLeads(paras.map((para) =>
    headingLike(para.text, { size: para.size, base, weight: para.bold ? 700 : 400 }) ? 'heading'
      : para.lines === 1 && shortItem(para.text) ? 'control' : 'body'), { startsSection: true });
  const items = paras.map((para, index) => ({ text: para.text, kind: kinds[index] }))
    .sort((a, b) => READING_TIER[a.kind] - READING_TIER[b.kind]);
  const seen = new Set();
  return items.filter(({ text }) => !seen.has(text) && seen.add(text));
}

function pageBatches(items, slots) {
  const short = chunk(items.filter(({ kind }) => kind === 'control'));
  const body = chunk(items.filter(({ kind }) => kind !== 'control'));
  while (body.length + short.length < slots) {
    const longest = body.reduce((best, part, index) => part.length > (body[best]?.length ?? 1) ? index : best, -1);
    if (longest < 0) break;
    const part = body[longest];
    const middle = Math.ceil(part.length / 2);
    body.splice(longest, 1, part.slice(0, middle), part.slice(middle));
  }
  return [...body, ...short];
}

export function createPdfQueue(pages) {
  const ordered = new Map();
  const pagesOf = new Map();
  const left = new Map();
  for (const [page, paras] of pages) {
    const items = readingOrder(paras.filter((para) => !para.skip));
    if (!items.length) continue;
    ordered.set(page, items);
    left.set(page, new Set(items.map(({ text }) => text)));
    for (const { text } of items) {
      if (!pagesOf.has(text)) pagesOf.set(text, []);
      pagesOf.get(text).push(page);
    }
  }
  const pending = new Set(pagesOf.keys());
  const distance = (page, focus) => page >= focus ? page - focus : (focus - page) * 1.5;

  function* batches(focus, slots) {
    const nearby = [...ordered.keys()].sort((a, b) => distance(a, focus) - distance(b, focus));
    for (const page of nearby) {
      const items = ordered.get(page).filter(({ text }) => pending.has(text));
      for (const part of pageBatches(items, slots)) yield part.map(({ text }) => text);
    }
  }

  function completedPages(part) {
    const finished = [];
    for (const text of part) {
      for (const page of pagesOf.get(text)) {
        const rest = left.get(page);
        if (!rest) continue;
        rest.delete(text);
        if (rest.size) continue;
        left.delete(page);
        ordered.delete(page);
        finished.push(page);
      }
    }
    return finished;
  }

  return {
    total: pending.size,
    chars: [...pending].reduce((sum, text) => sum + text.length, 0),
    async run({ parallel, focus, signal, translate, onResult }) {
      const inflight = new Set();
      const replies = [];
      let wake;
      const abort = () => wake?.();
      const received = (reply) => {
        if (signal.aborted) return;
        replies.push(reply);
        wake?.();
      };
      signal.addEventListener('abort', abort, { once: true });
      const fill = () => {
        if (signal.aborted || !pending.size || inflight.size >= parallel) return;
        for (const part of batches(focus(), parallel - inflight.size)) {
          for (const text of part) pending.delete(text);
          inflight.add(part);
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return translate(part, signal);
          }).then((results) => received({ part, results }), (error) => received({ part, error }));
          if (inflight.size >= parallel) break;
        }
      };
      try {
        fill();
        while (inflight.size && !signal.aborted) {
          if (!replies.length) await new Promise((resolve) => { wake = resolve; });
          wake = null;
          if (signal.aborted) break;
          const reply = replies.shift();
          if (reply.error) throw reply.error;
          inflight.delete(reply.part);
          const pages = completedPages(reply.part);
          fill();
          onResult(reply.part, reply.results, pages);
        }
      } finally {
        signal.removeEventListener('abort', abort);
        for (const part of inflight) for (const text of part) pending.add(text);
      }
      return pending.size > 0;
    },
  };
}
