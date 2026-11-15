// 変化する並行作業のartifact IDを固定値へ埋めず、同じbaseから前後比較する。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from '../../build.mjs';
import { buildPlan, loadPatchGroups } from '../../patch-plan.mjs';
import { workRoot } from '../../support.mjs';
import { profile } from '../../../profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const recipe = path.resolve(here, '../..');
const kind = process.argv[2] ?? 'attn';
assert(['attn', 'prefill'].includes(kind), '指定: attn または prefill');
assert(process.argv.slice(3).every(a => a === '--plan'), '追加引数: --plan のみ');
const groups = ['commands', 'sampling', 'matmul', 'result'];
const dirs = names => names.map(n => path.join(recipe, 'patches', n)).join(',');
const pins = JSON.parse(fs.readFileSync(path.join(recipe, 'pins.json')));
const plan = names => buildPlan('profile-gpu', pins, loadPatchGroups(dirs(names)));
const reference = plan(groups), candidate = plan([...groups, kind]);
console.log(JSON.stringify({ kind, reference: reference.artifactId, candidate: candidate.artifactId,
  baselineEquivalent: buildPlan('baseline', pins, loadPatchGroups(dirs(groups))).artifactId,
  referenceInputHash: reference.inputHash, candidateInputHash: candidate.inputHash }, null, 2));
if (!process.argv.includes('--plan')) {
  const root = workRoot();
  const base = await build(['--variant', 'profile-gpu', '--patches', dirs(groups)]);
  assert.equal(base.inputHash, reference.inputHash, '基準ビルド中に入力が変わったため、再実行する');
  assert.equal(plan(groups).inputHash, reference.inputHash, '基準ビルド後に入力が変わったため、再実行する');
  const modified = await build(['--variant', 'profile-gpu', '--patches', dirs([...groups, kind])]);
  assert.equal(modified.inputHash, candidate.inputHash, '候補ビルド中に入力が変わったため、再実行する');
  assert.equal(plan(groups).inputHash, reference.inputHash, '比較元の入力が変わったため、再実行する');
  const common = { backend_sampling: true, backend_sampling_token_only: true, cache_prompt: false };
  const comparisonDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-gpu-kernels-profile-'));
  const file = path.join(comparisonDirectory, `${kind}-cases.json`);
  // latestの更新と独立した、今回生成した成果物のディレクトリを使う。
  const cases = [{ id: 'reference', artifact: { directory: path.relative(root, base.artifactDir) }, completionExtra: common },
    { id: 'candidate', artifact: { directory: path.relative(root, modified.artifactDir) }, completionExtra: common }];
  fs.writeFileSync(file, JSON.stringify({ cases, pairs: [{ referenceId: 'reference', candidateId: 'candidate', equivalent: false }] }, null, 2) + '\n');
  console.log(`比較条件: ${file}`);
  await profile(['--models', '0.8B', '--parallel', '8', '--ubatch', '512', '--device', 'gpu', '--quality-replays', '2', '--cases', file]);
}
