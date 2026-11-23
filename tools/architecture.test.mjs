// 設計の決まり（docs/11_設計方針.md）を機械で確かめる。決まりが破られても普段の利用では気づけず、
// 症状ごとの例外が積み重なって流れが読めなくなる（2026-11-16、<br>・太字・コードの空の箱を個別に直していた件）ので、ここで止める。
// 実行：npm test（node --test tools/unit.test.mjs tools/architecture.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const LAYERS = ['shared', 'core', 'background', 'offscreen', 'page', 'pdf', 'ui'];
/** 層ごとに読み込んでよい層（vendor は同梱の外部ライブラリ）。 */
const ALLOWED = {
  shared: ['shared'],
  core: ['core', 'shared'],
  background: ['background', 'core', 'shared'],
  offscreen: ['offscreen', 'shared', 'vendor'],
  page: ['page', 'shared'],
  pdf: ['pdf', 'shared', 'vendor'],
  ui: ['ui', 'shared', 'pdf', 'vendor'],
};
/** DOM にも chrome にも触れない純粋な関数だけを置くモジュール（Node の単体試験で確かめられる形を保つ）。 */
const PURE = ['shared/markup.js', 'shared/text.js', 'shared/prompt.js', 'shared/sentences.js', 'shared/fonts.js'];

const sources = LAYERS.flatMap((layer) => fs.readdirSync(path.join(ROOT, layer)).filter((f) => f.endsWith('.js')).map((f) => `${layer}/${f}`));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** コメントを除いた本文（説明の文中の語で誤検出しない）。 */
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

test('層の依存：各層は決められた層だけを読み込む', () => {
  const bad = [];
  for (const rel of sources) {
    const layer = rel.split('/')[0];
    for (const [, spec] of code(rel).matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      if (!spec.startsWith('.')) continue;
      const target = path.relative(ROOT, path.resolve(path.join(ROOT, layer), spec)).split(path.sep)[0];
      if (!ALLOWED[layer].includes(target)) bad.push(`${rel} → ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('純粋なモジュールは DOM・chrome に触れない', () => {
  const bad = PURE.filter((rel) => /\b(document|window|chrome|getComputedStyle|Node)\./.test(code(rel)));
  assert.deepEqual(bad, []);
});

test('マーカーの文法は shared/markup.js だけに書く（作る側・読む側・判定がそれぞれ別の形を持たない）', () => {
  // マーカーを作る・読む書き方：`<a${`、`<c1>` のようなマーカーの文字、[ac]・[acv] の文字クラス。
  const grammar = /<\/?[acv]\$\{|\[a?cv?\]\\d|<\\?\/?[acv]\(?\\d/;
  const bad = sources.filter((rel) => rel !== 'shared/markup.js' && grammar.test(code(rel)));
  assert.deepEqual(bad, []);
});

test('段落の中の要素の分類は page/paragraph.js の roleOf だけで行う（書き込み側は要素の種類を見ない）', () => {
  const write = code('page/write.js');
  assert.doesNotMatch(write, /tagName|nodeName|matches\(|closest\(/, 'page/write.js は decode の木を DOM にするだけにする');
  // 訳文表示で隠す要素は paragraph.js が決め（hide）、write.js が印を付ける。ほかの場所で印を付けない。
  const setters = sources.filter((rel) => /setAttribute\(['"]data-plamo-hide/.test(code(rel)));
  assert.deepEqual(setters, ['page/write.js']);
});

test('段落のフィールドは page/para.js の PARA_FIELDS が決めたモジュールだけが書く', () => {
  // ページ側のモジュールは Node で読み込めない（chrome・document に触れる）ので、表は本文から読む。
  const table = code('page/para.js').match(/PARA_FIELDS = (\{[\s\S]*?\});/)[1];
  const owners = JSON.parse(table.replace(/'/g, '"').replace(/,\s*\}/, '}'));
  const ownerOf = new Map(Object.entries(owners).flatMap(([rel, fields]) => fields.map((f) => [f, rel])));
  assert.ok(ownerOf.size >= 15, '表を読めていない');
  const fields = [...ownerOf.keys()].join('|');
  // 代入（=・??=・+=・++）と Object.assign(para, { … })。style.fontFamily のような別のオブジェクトへの代入は除く。
  const assign = new RegExp(`(?<!style)\\.(${fields})\\s*(?:=(?!=)|\\?\\?=|\\+=|\\+\\+)`, 'g');
  const bad = [];
  for (const rel of sources.filter((r) => r.startsWith('page/'))) {
    const body = code(rel);
    for (const [, field] of body.matchAll(assign)) if (ownerOf.get(field) !== rel) bad.push(`${rel}：${field}`);
    for (const [, keys] of body.matchAll(/Object\.assign\(para,\s*\{([^}]*)\}/g)) {
      for (const field of keys.split(',').map((k) => k.trim().split(':')[0])) if (ownerOf.get(field) !== rel) bad.push(`${rel}：${field}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('サイトの書き換えへの追従は page/sync.js だけが行う（MutationObserver で段落を集め直す場所を1つにする）', () => {
  const observers = sources.filter((rel) => rel.startsWith('page/') && /new MutationObserver/.test(code(rel)));
  // write.js は表示の属性（data-plamo-mode）を付け直すだけで、段落には触れない。
  assert.deepEqual(observers.sort(), ['page/sync.js', 'page/write.js']);
});

test('独自の呼び名を使わない（docs/11_設計方針.md「使わない言い換え」の表の語が、文書・コード・画面に無い）', () => {
  const repo = path.resolve(ROOT, '..');
  const policy = fs.readFileSync(path.join(repo, 'docs/11_設計方針.md'), 'utf8');
  const table = policy.split('### 使わない言い換え')[1].split(/\n#/)[0];
  const banned = [...table.matchAll(/^\| ([^|]+?) \| [^|]+ \|$/gm)].map((m) => m[1]).filter((w) => w !== '使わない語' && !/^-+$/.test(w));
  assert.ok(banned.length >= 10, '表を読めていない');
  // 調べる範囲：リポジトリの文書・拡張機能・ツール。同梱の外部ライブラリ、生成物、Git の外のメモ、この表そのものは除く。
  const SKIP = new Set(['.git', 'node_modules', 'dist', 'local-notes', 'vendor']);
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(md|js|mjs|html|css|json|py)$/.test(e.name)) files.push(p);
    }
  };
  walk(repo);
  const bad = [];
  for (const file of files) {
    if (path.relative(repo, file) === path.join('docs', '11_設計方針.md')) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const word of banned) if (text.includes(word)) bad.push(`${path.relative(repo, file)}：${word}`);
  }
  assert.deepEqual(bad, []);
});
