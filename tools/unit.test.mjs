// 壊れても普段の利用では気づけないまま訳文が欠ける・誤るものだけを確かめる（docs/06「試験」）。実行：node --test tools/unit.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { pageReadable, runaway, splitLong, untranslated } from '../extension/shared/text.js';
import { translateBatch } from '../extension/core/translator.js';
import { decode, encode, previewLine, remainingSource } from '../extension/shared/markup.js';
import { LOG_SOURCE, MSG } from '../extension/shared/messages.js';
import { createPdfQueue } from '../extension/pdf/queue.js';
import { createPdfBatchRequests } from '../extension/ui/pdf-batches.js';
import { analyzeUx, dispatchDiagnostics, median } from './profile/replay-ux-analysis.mjs';

const pdfParas = (...texts) => texts.map((text) => ({ text, plain: text, size: 12, lines: 1 }));

test('PDFのバッチの返事が逆順でも、段落がそろったページは1回だけ書く', async () => {
  const queue = createPdfQueue(new Map([
    [0, pdfParas('First paragraph.', 'Shared paragraph.')],
    [1, pdfParas('Shared paragraph.', 'Last paragraph.')],
  ]));
  const replies = new Map();
  const written = [];
  const running = queue.run({
    parallel: 3, focus: () => 0, signal: new AbortController().signal,
    translate([text]) {
      const reply = Promise.withResolvers();
      replies.set(text, reply);
      return reply.promise;
    },
    onResult(_part, _results, pages) { written.push(...pages); },
  });
  await new Promise(setImmediate);
  assert.deepEqual([...replies.keys()], ['First paragraph.', 'Shared paragraph.', 'Last paragraph.']);
  replies.get('Last paragraph.').resolve(['最後の段落。']);
  await new Promise(setImmediate);
  assert.deepEqual(written, []);
  replies.get('Shared paragraph.').resolve(['共通の段落。']);
  await new Promise(setImmediate);
  assert.deepEqual(written, [1]);
  replies.get('First paragraph.').resolve(['最初の段落。']);
  assert.equal(await running, false);
  assert.deepEqual(written, [1, 0]);
});

test('PDFの中止は未完了の全バッチを取り消し、古い返事を使わずに続きから訳す', async () => {
  const queue = createPdfQueue(new Map([[0, pdfParas('First paragraph.', 'Second paragraph.', 'Third paragraph.')]]));
  const requests = new Map();
  const cancelled = [];
  const batches = createPdfBatchRequests(async ({ type, id, texts }) => {
    if (type === MSG.CANCEL) cancelled.push(id);
    else {
      const reply = Promise.withResolvers();
      requests.set(id, { texts, ...reply });
      return reply.promise;
    }
  });
  const done = [];
  const options = {
    parallel: 3, focus: () => 0,
    translate: batches.translate,
    onResult(part, _results, pages) { done.push({ part, pages }); },
  };
  const controller = new AbortController();
  const first = queue.run({ ...options, signal: controller.signal });
  await new Promise(setImmediate);
  requests.get(1).resolve({ ok: true, results: ['最初の段落。'] });
  await new Promise(setImmediate);
  controller.abort();
  batches.cancel();
  assert.equal(await first, true);
  assert.deepEqual(cancelled, [2, 3]);
  const resumed = queue.run({ ...options, signal: new AbortController().signal });
  await new Promise(setImmediate);
  assert.deepEqual([requests.get(4).texts, requests.get(5).texts], [['Second paragraph.'], ['Third paragraph.']]);
  for (const id of cancelled) requests.get(id).resolve({ ok: true, results: ['古い返事。'] });
  await new Promise(setImmediate);
  assert.deepEqual(done, [{ part: ['First paragraph.'], pages: [] }]);
  for (const id of [4, 5]) requests.get(id).resolve({ ok: true, results: ['再開後の訳文。'] });
  assert.equal(await resumed, false);
  assert.deepEqual(done.flatMap(({ pages }) => pages), [0]);
});

test('UX の完了時刻と網羅率は非表示とスクロール時の対象を分けて数える', () => {
  const inventory = [
    { id: 1, initial: 'viewport', source: 'Heading', rendered: '見出し', lead: true, completeAt: 110, displayChanges: [] },
    { id: 2, initial: 'viewport', source: 'Lead. Keep reading.', rendered: '最初の文です。続きです。', lead: true, paragraph: true, completeAt: 125,
      displayChanges: [{ at: 109, text: '最初の文です。 Keep reading.', position: 'viewport' }] },
    { id: 3, initial: 'shown', source: 'Next', rendered: '次の段落', afterScroll: true, paragraph: true, completeAt: 147,
      displayChanges: [{ at: 144, text: '次の段落', position: 'viewport' }], evidence: { output: true } },
    { id: 4, initial: 'hidden', source: 'Menu', rendered: 'Menu', collapsed: true, completeAt: null, displayChanges: [] },
    { id: 5, initial: 'viewport', source: 'Another.', rendered: '別の段落です。', paragraph: true, completeAt: 125,
      displayChanges: [{ at: 106, text: 'Another.', position: 'viewport' }, { at: 124, text: '別の段落です。', position: 'viewport' }] },
  ];
  const result = analyzeUx({ startAt: 100, observedAt: 180, scroll: { at: 127 }, inventory,
    events: [{ at: 110, complete: true }, { at: 125, complete: true }, { at: 125, complete: true }, { at: 147, complete: true }] });
  assert.equal(result.initialViewportMs, 25);
  assert.equal(result.headingsAndLeadMs, 25);
  assert.equal(result.firstViewportSentenceMs, 9);
  assert.equal(result.initialParagraphReadMs, 24);
  assert.equal(result.scrolledParagraphReadMs, 20);
  assert.equal(result.scrollFollowMs, 20);
  assert.equal(result.shownMs, 47);
  assert.equal(result.totalMs, null);
  assert.deepEqual(result.counts.collapsed, { translated: 0, total: 1 });
  assert.deepEqual(result.coverage, [
    { ms: 0, translated: 0 }, { ms: 10, translated: 1 }, { ms: 25, translated: 3 },
    { ms: 47, translated: 4 }, { ms: 80, translated: 4 },
  ]);
  assert.deepEqual(result.incomplete, [4]);
  assert.equal(median([10, null, 20]), 15);
});

test('生成枠の占有は枠の取得・解放で数え、受信待ち時間とは分ける', () => {
  const traces = [
    { source: LOG_SOURCE.model, event: '生成', startAt: 101, acquiredAt: 104, releasedAt: 110 },
    { source: LOG_SOURCE.model, event: '生成', requestId: 'page:3', startAt: 105, acquiredAt: 108, releasedAt: 114, genMs: 4 },
    { event: '受信', id: 1, pageAt: 111, pagePending: 2 },
    { event: '送信対象選択', selectedAt: 112, ms: 0.25, pending: 2, selected: 1 },
    { event: '送信', id: 3, pageAt: 105, lines: 5, screen: 4 },
    { event: '送信', id: 4, pageAt: 113 },
    { event: '受信', id: 2, pageAt: 115, pagePending: 1 },
    { event: '受信', id: 3, pageAt: 116, ms: 11, pagePending: 0 },
  ];
  const result = dispatchDiagnostics(traces, 100, 120, 2);
  assert.deepEqual(result.occupancy, [[0, 0], [4, 1], [8, 2], [10, 1], [14, 0]]);
  assert.deepEqual(result.byCount, { 0: 10, 1: 8, 2: 2 });
  assert.deepEqual(result.requests[0], { id: 3, sentMs: 5, lines: 5, screen: 4,
    replies: [{ atMs: 16, elapsedMs: 11, outcome: '受信' }],
    generations: [{ acquiredMs: 8, releasedMs: 14, genMs: 4, outcome: '生成' }] });
  assert.deepEqual(result.replyToNextSend.map((reply) => reply.gapMs), [2, null]);
  assert.deepEqual(result.selection, [{ at: 12, ms: 0.25, pending: 2, selected: 1 }]);
});

test('splitLong：長い段落を文の切れ目で分ける', () => {
  const text = 'This is a sentence. '.repeat(100);
  const parts = splitLong(text, 300);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 300));
  assert.equal(parts.join(''), text);
  assert.deepEqual(splitLong('short', 300), ['short']);
});

test('runaway：正常な訳文と原文にある繰り返しは打ち切らない', () => {
  assert.equal(runaway('この路線は唐峠駅を出発し、五一島駅まで運行しています。', 1), 0);
  assert.equal(runaway('一行目です。\n二行目です。', 2), 0);
  assert.equal(runaway('ーーーーーーーー', 1), 0, '短い記号の連続は見ない');
  assert.equal(runaway('分 分 分 分 分 min min min min min min', 1, 'min min min min min min'.length), 0, '原文にある繰り返しは止めない');
  assert.equal(runaway('コピー済み コピー済み コピー済み コピー済み コピー済み コピー済み', 1, 'Copied Copied Copied Copied Copied Copied'.length), 0, '原文の並びと同じ長さなら止めない');
});

test('translateBatch：モデルが1段落を複数行に分けて返しても、各段落に自分の訳が全文付く', async () => {
  // 訳文のキャッシュは IndexedDB の無い Node ではメモリーだけで動き、開けない旨を警告する。試験の出力に混ぜない。
  mock.method(console, 'warn', () => {});
  const texts = ['Alpha paragraph.', 'Beta has three sentences. One. Two.', 'Gamma paragraph.', 'Delta paragraph.'];
  const want = ['アルファの段落。', 'ベータは3文ある。\nその1。\nその2。', 'ガンマの段落。', 'デルタの段落。'];
  // Offscreen Documentの代わり。原文の各行を訳し（Beta だけ3行に分ける）、offscreen.js と同じく1字ずつ runaway に通して打ち切る。
  globalThis.chrome = {
    offscreen: { hasDocument: async () => true },
    runtime: {
      sendMessage: async (m) => {
        const full = texts.filter((t) => m.prompt.includes(t)).map((t) => want[texts.indexOf(t)]).join('\n');
        let text = '';
        let keep = 0;
        for (const ch of full) if ((keep = runaway((text += ch), m.lines, m.sourceChars))) break;
        return { ok: true, text: keep ? text.slice(0, keep) : text, cut: !!keep, tokens: 0, loadMs: 0 };
      },
    },
  };
  const { results } = await translateBatch(texts, { model: 'unit-test', form: 'polite' });
  assert.deepEqual(results, want);
});

// ---- 段落のマーカーの文法（shared/markup.js）：壊れると、訳文から太字・リンク・コード・改行が黙って消える、原文のまま写される ----
const open = (id) => ({ type: 'open', id });
const close = (id) => ({ type: 'close', id });
const txt = (text) => ({ type: 'text', text });

test('encode：段落の中の要素をマーカーにし、マーカーの内側の端の空白を外へ出す', () => {
  const tokens = [txt('Read '), open(1), txt(' the '), open(2), txt('guide'), close(2), txt(' '), close(1), { type: 'space' },
    { type: 'void', id: 3, br: false }, txt(' and run '), { type: 'code', id: 4, text: ' npm  test ' }, txt('.')];
  assert.deepEqual(encode(tokens), { text: 'Read <a1>the <a2>guide</a2></a1> <v3/> and run <c4>npm test</c4>.', plain: 'Read the guide and run .' });
});

test('encode：訳す文字がすべて飾りの中にある行も、飾りのマーカーを残す（バッジの見た目を訳文に写す）', () => {
  const label = [open(1), { type: 'code', id: 2, text: 'Navigator.bluetooth' }, close(1), { type: 'space' }, open(3), txt('Read only'), close(3)];
  assert.equal(encode(label).text, '<a1><c2>Navigator.bluetooth</c2></a1> <a3>Read only</a3>');
});

test('encode：文の途中の <br> は空白にし、行の区切りの <br> はマーカーにする', () => {
  const br = (id) => ({ type: 'void', id, br: true });
  assert.equal(encode([txt('run it after'), br(1), txt('every change.')]).text, 'run it after every change.');
  assert.equal(encode([open(1), txt('Environment'), close(1), br(2), txt('Air Sync 0.2.2'), br(3), txt('Backend: Drive')]).text,
    '<a1>Environment</a1><v2/>Air Sync 0.2.2<v3/>Backend: Drive');
});

test('decode：入れ子・写す要素・文字の無い要素を木に戻す。訳文にマーカーをそのまま返せば元の構造になる', () => {
  const kinds = ['a', 'a', 'v', 'c'];
  const tree = decode('<a1>ガイドの<a2>手引き</a2></a1><v3/>を読み、<c4>npm test</c4>を実行', kinds);
  assert.deepEqual(tree, [
    { type: 'wrap', id: 1, children: [txt('ガイドの'), { type: 'wrap', id: 2, children: [txt('手引き')] }] },
    { type: 'void', id: 3 }, txt('を読み、'), { type: 'code', id: 4 }, txt('を実行'),
  ]);
});

test('decode：崩れたマーカーは捨てて文字を残し、閉じなかった要素は外す。文字を HTML として扱わない', () => {
  const kinds = ['a', 'a'];
  assert.deepEqual(decode('<a1>しない</a1>で<a2>残り', kinds), [{ type: 'wrap', id: 1, children: [txt('しない')] }, txt('で'), txt('残り')]);
  assert.deepEqual(decode('<a1>外<a2>内</a1>後', kinds), [{ type: 'wrap', id: 1, children: [txt('外'), txt('内')] }, txt('後')], '外側が先に閉じたら内側を外す');
  assert.deepEqual(decode('<a9>番号違い</a9><c1>x</c1>', kinds), [txt('番号違い'), txt('x')], '番号・種類の合わないマーカーは文字だけ');
  assert.deepEqual(decode('<img src=x onerror=alert(1)>', kinds), [txt('<img src=x onerror=alert(1)>')]);
});

test('途中表示は閉じた文末で切り、原文の残りは文をまたぐ書式ごと保つ', () => {
  assert.deepEqual(previewLine('「1.23です。」次の文'), { text: '「1.23です。」', sentences: 1 });
  assert.deepEqual(previewLine('The value is 1.23. Next'), { text: 'The value is 1.23.', sentences: 1 });
  assert.deepEqual(previewLine('أين الملف؟ الجملة التالية'), { text: 'أين الملف؟', sentences: 1 });
  assert.deepEqual(remainingSource('<a1>First. Second</a1> sentence.', ['a'], 1), [
    { type: 'wrap', id: 1, children: [txt('Second')] }, txt(' sentence.'),
  ]);
});

test('途中表示に書きかけのマーカーとコピーする要素の中身が漏れない', () => {
  const line = '<a1>リンクです。</a1><c2>foo.bar.';
  const expected = '<a1>リンクです。</a1>';
  assert.equal(previewLine(line).text, expected);
  assert.equal(previewLine(line, true).text, expected);
  assert.equal(previewLine(expected + '</a').text, expected);
  assert.equal(previewLine('<c2>foo.bar.</c2> 続きは').text, '');
  assert.deepEqual(decode(previewLine('<a1>リンクです。続きは').text, ['a']), [txt('リンクです。')]);
});

test('確定した訳文が途中の文字列と同じでも、原文の残りを消して書式を確定する', async (t) => {
  const savedChrome = globalThis.chrome;
  globalThis.chrome = { storage: { sync: { get: async () => ({}) }, onChanged: { addListener() {} } } };
  const { apply } = await import('../extension/page/write.js').finally(() => (globalThis.chrome = savedChrome));
  const attributes = new Map([['data-plamo-orig', 'partial']]);
  const wrapper = { hasAttribute: (name) => attributes.has(name), getAttribute: (name) => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name) };
  const translation = '<a1>確定です。</a1>';
  const link = { removeAttribute() {}, querySelectorAll: () => [], append: t.mock.fn() };
  const trSpan = { isConnected: true, removeAttribute: t.mock.fn(), replaceChildren: t.mock.fn() };
  const para = {
    nodes: [{ isConnected: true, parentElement: wrapper }],
    element: { removeAttribute() {}, style: { removeProperty() {} } },
    trSpan, translation: null, partial: { text: translation, complete: false },
    marks: [{ kind: 'a', el: { cloneNode: () => link } }],
  };
  globalThis.document = { createTextNode: txt };
  t.after(() => { delete globalThis.document; });
  apply(para, translation);
  assert.equal(para.translation, translation);
  assert.equal(para.partial, null);
  assert.equal(attributes.get('data-plamo-orig'), 'done');
  assert.deepEqual(trSpan.removeAttribute.mock.calls[0].arguments, ['data-plamo-partial']);
  assert.deepEqual(trSpan.replaceChildren.mock.calls[0].arguments, [link]);
  assert.deepEqual(link.append.mock.calls[0].arguments, [txt('確定です。')]);
});

test('untranslated：短い英字のバッジだけの行は、英語のまま返っても訳し直さない。地の文のある行は訳し直す', () => {
  const badges = '<a1><c2>Navigator.bluetooth</c2></a1> <a3>Read only</a3> <a4>Secure context</a4>';
  assert.equal(untranslated(badges, badges), false);
  const sentence = 'Returns a <a1><c2>Bluetooth</c2></a1> object for the current document.';
  assert.equal(untranslated(sentence, sentence), true);
  assert.equal(untranslated('<a1>This value may not be changed by scripts</a1>', '<a1>This value may not be changed by scripts</a1>'), true, '長い文のバッジは訳し直す');
});

test('pageReadable：HTML・XML・テキストの文書だけページ側の部品を使う。PDF・画像は内蔵ビューアの文書として扱う', () => {
  for (const t of ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/xml', 'text/plain', '']) assert.equal(pageReadable(t), true, t);
  for (const t of ['application/pdf', 'image/png', 'video/mp4']) assert.equal(pageReadable(t), false, t);
});
