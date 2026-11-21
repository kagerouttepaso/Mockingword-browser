import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeUx, summarizeUxRuns, unchangedUxItems } from './replay-ux-analysis.mjs';
import { mockingwordObservation, sakuttoObservation } from './replay-ux-observation.mjs';

test('Mockingwordの途中表示を除き、DOMの再書き込みなしで確定した原文と同じ訳も数える', () => {
  const node = { data: 'Example [123]', parentElement: { matches: () => true } };
  const paragraph = { text: node.data, translation: node.data, trSpan: { isConnected: true, textContent: node.data } };
  const state = { owner: new WeakMap([[node, paragraph]]), cache: new Map() };
  const observe = mockingwordObservation(state);
  assert.deepEqual(observe.inspect(node), { marked: true, applied: false });
  state.cache.set(paragraph.text, paragraph.translation);
  assert.deepEqual(observe.inspect(node), { marked: true, applied: true });
  paragraph.trSpan.textContent = '';
  assert.deepEqual(observe.inspect(node), { marked: true, applied: false });
  paragraph.trSpan.textContent = node.data;
  paragraph.trSpan.isConnected = false;
  assert.deepEqual(observe.inspect(node), { marked: true, applied: false });
});

test('sakuttoは途中表示や保留解除だけでなく、確定時に書き込んだ元のノードを数える', () => {
  const attrs = new Map([['data-sakutto-id', 'one'], ['data-sakutto-pending', '1']]);
  const block = { getAttribute: (name) => attrs.get(name), hasAttribute: (name) => attrs.has(name),
    closest: () => attrs.has('data-sakutto-id') ? block : null };
  const node = { data: 'Example [123]', parentElement: block };
  const excluded = { data: 'Not part of the segment', parentElement: block };
  const id = { type: 'attributes', target: block, attributeName: 'data-sakutto-id' };
  const write = { type: 'characterData', target: node };
  const release = { type: 'attributes', target: block, attributeName: 'data-sakutto-pending', oldValue: '1' };
  const observe = sakuttoObservation();
  observe.observe([id, write]);
  assert.deepEqual(observe.inspect(node), { marked: true, applied: false });
  attrs.delete('data-sakutto-pending');
  observe.observe([release]);
  assert.deepEqual(observe.inspect(node), { marked: true, applied: false });
  observe.observe([id, write, release]);
  assert.deepEqual(observe.inspect(node), { marked: true, applied: true });
  assert.deepEqual(observe.inspect(excluded), { marked: true, applied: false });
  attrs.delete('data-sakutto-id');
  assert.deepEqual(observe.inspect(node), { marked: false, applied: false });
});

test('完了は原文との一致に依存せず、未到達は到達時間の範囲に混ぜない', () => {
  const makeRun = (at) => {
    const inventory = [
      { id: 1, tag: 'p', initial: 'viewport', lead: true, paragraph: true, afterScroll: true, source: 'Same', rendered: 'Same', completeAt: at, displayChanges: [],
        evidence: { output: true } },
      { id: 2, tag: 'div', initial: 'hidden', source: 'Unset', rendered: 'Unset', completeAt: null, displayChanges: [] },
    ];
    const ux = analyzeUx({ startAt: 100, observedAt: 300, scroll: { at: 230 }, inventory,
      events: at === null ? [] : [{ at, id: 1, complete: true }] });
    return { ux, quality: { unchanged: unchangedUxItems(inventory) } };
  };
  const runs = [makeRun(200), makeRun(null), makeRun(210)];
  assert.deepEqual(runs[0].quality.unchanged, { count: 1, items: [{ id: 1, tag: 'p', source: 'Same' }] });
  assert.equal(runs[0].ux.scrollFollowMs, 0);
  assert.deepEqual(summarizeUxRuns({ default: runs }).default.ms.initialViewportMs, { reached: 2, median: 105, min: 100, max: 110,
    misses: [{ round: 2, coverage: { translated: 0, total: 1 }, all: { translated: 0, total: 2 } }] });
});

test('確定反映が分かっても、項目別の表示が取れなければ原文同一とは数えない', () => {
  const item = { id: 1, tag: 'li', source: 'Same', rendered: 'Same', completeAt: 200, evidence: { output: false } };
  assert.deepEqual(unchangedUxItems([item]), { count: 0, items: [] });
});
