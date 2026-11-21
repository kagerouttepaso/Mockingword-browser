export function mockingwordObservation(state) {
  const original = '[data-plamo-orig=done], [data-plamo-hide]';
  return {
    original,
    attributes: ['data-plamo-orig', 'data-plamo-hide'],
    checkAfterPaint: !!state,
    inspect(node) {
      const marked = node.parentElement?.matches('[data-plamo-orig=done]') ?? false;
      const paragraph = state?.owner.get(node);
      const applied = !!(marked && paragraph?.trSpan?.isConnected && paragraph.trSpan.textContent.trim() && state.cache.has(paragraph.text) &&
        state.cache.get(paragraph.text) === paragraph.translation);
      return { marked, applied };
    },
    hasOutput: (nodes) => nodes.some((node) => node.data.trim() && node.parentElement.closest('.plamo-tr')),
  };
}

export function sakuttoObservation() {
  const id = 'data-sakutto-id';
  const pending = 'data-sakutto-pending';
  const selector = `[${id}]`;
  const applied = new WeakMap();
  return {
    attributes: [id, pending],
    observe(records) {
      const paints = new Map();
      for (const record of records) {
        const { target } = record;
        if (record.attributeName === id) {
          paints.set(target, new Set());
        } else if (record.type === 'characterData') {
          const block = target.parentElement?.closest(selector);
          paints.get(block)?.add(target);
        } else if (record.attributeName === pending && record.oldValue === '1' && !target.hasAttribute(pending)) {
          const marker = target.getAttribute(id);
          if (marker) for (const node of paints.get(target) ?? []) applied.set(node, { block: target, marker });
          paints.delete(target);
        }
      }
    },
    inspect(node) {
      const block = node.parentElement?.closest(selector);
      const proof = applied.get(node);
      return { marked: !!block, applied: !!block && !block.hasAttribute(pending) &&
        proof?.block === block && proof.marker === block.getAttribute(id) };
    },
    hasOutput: (nodes) => nodes.some((node) => node.data.trim()),
  };
}
