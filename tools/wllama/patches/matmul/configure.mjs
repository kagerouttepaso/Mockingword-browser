import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--max-rows' || !/^\d+$/.test(args[1])) {
  throw new Error('使い方: node configure.mjs --max-rows 4以上の整数');
}
const rows = Number(args[1]);
if (!Number.isSafeInteger(rows) || rows < 4 || rows > 65535) {
  throw new Error('--max-rows は4〜65535です。通常は4・16、prefill比較では32・64を指定します');
}
const file = path.join(import.meta.dirname, '0001-batch-mmvq-columns.patch');
const text = fs.readFileSync(file, 'utf8');
const pattern = /^(\+#define GGML_WEBGPU_MMVQ_MAX_ROWS\s+)\d+$/gm;
if ([...text.matchAll(pattern)].length !== 1) throw new Error('上限定義が一意ではありません');
fs.writeFileSync(file, text.replace(pattern, (_, prefix) => prefix + rows));
console.log(`MMVQ 行数上限を ${rows} に設定しました。パッチを用いて再ビルドしてください`);
