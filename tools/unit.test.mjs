// 壊れても普段の利用では気づけないまま訳文が欠ける・誤るものだけを確かめる（docs/06「試験」）。実行：node --test tools/unit.test.mjs
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { runaway, splitLong } from '../extension/shared/text.js';
import { translateBatch } from '../extension/core/translator.js';

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
  // 訳の控えは IndexedDB の無い Node ではメモリーだけで動き、開けない旨を警告する。試験の出力に混ぜない。
  mock.method(console, 'warn', () => {});
  const texts = ['Alpha paragraph.', 'Beta has three sentences. One. Two.', 'Gamma paragraph.', 'Delta paragraph.'];
  const want = ['アルファの段落。', 'ベータは3文ある。\nその1。\nその2。', 'ガンマの段落。', 'デルタの段落。'];
  // 見えないページの代わり。原文の各行を訳し（Beta だけ3行に分ける）、offscreen.js と同じく1字ずつ runaway に通して打ち切る。
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
