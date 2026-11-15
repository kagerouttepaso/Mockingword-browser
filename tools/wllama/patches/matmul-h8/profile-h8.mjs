import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../build.mjs';
import { buildPlan, loadPatchGroups } from '../../patch-plan.mjs';
import { readArgs } from '../../support.mjs';
import { profile } from '../../../profile.mjs';

// 0002だけの診断入力をTEMPへ固定し、0003と混ぜずに同じ実験で比較する。
export async function profileH8(argv = process.argv.slice(2)) {
  const args = readArgs(argv, { '--plan': 'flag', '--work-root': 'value', '--help': 'flag' });
  if (args.help) {
    console.log('node tools/wllama/patches/matmul-h8/profile-h8.mjs [--plan] [--work-root DIR]');
    return;
  }
  const recipe = path.resolve(import.meta.dirname, '../..');
  const pins = JSON.parse(fs.readFileSync(path.join(recipe, 'pins.json'), 'utf8'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'plamo-h8-profile-'));
  const originalH8 = path.join(temporary, 'h8-0002'); fs.mkdirSync(originalH8);
  fs.copyFileSync(path.join(import.meta.dirname, '0002-share-weights-across-eight-columns.patch'), path.join(originalH8, '0002-share-weights-across-eight-columns.patch'));
  const core = ['commands', 'sampling', 'matmul', 'result'].map(group => path.join(recipe, 'patches', group));
  const definitions = [
    { id: 'reference', groups: core },
    { id: 'h8_256', groups: [...core, originalH8] },
    { id: 'h8_128', groups: [...core, import.meta.dirname] }
  ];
  const completionExtra = { backend_sampling: true, backend_sampling_token_only: true, cache_prompt: false };
  const configurations = definitions.map(item => {
    const groupArgument = item.groups.join(',');
    const plan = buildPlan('profile-gpu', pins, loadPatchGroups(groupArgument));
    return { ...item, groupArgument, artifact: plan.artifactId, inputHash: plan.inputHash, patchCount: plan.patches.length };
  });
  const cases = {
    cases: configurations.map(({ id, artifact }) => ({ id, artifact, completionExtra })),
    pairs: [
      { referenceId: 'reference', candidateId: 'h8_256', equivalent: false },
      { referenceId: 'reference', candidateId: 'h8_128', equivalent: false },
      { referenceId: 'h8_256', candidateId: 'h8_128', equivalent: false }
    ]
  };
  const casesFile = path.join(temporary, 'cases.json');
  fs.writeFileSync(casesFile, JSON.stringify(cases, null, 2) + '\n');
  const workArgument = args['work-root'] ? ['--work-root', args['work-root']] : [];
  const profileArgs = ['--cases', casesFile, '--models', '0.8B', '--parallel', '8', ...workArgument];
  const experiment = { configurations, casesFile, cases, profileArgs };
  fs.writeFileSync(path.join(temporary, 'experiment.json'), JSON.stringify(experiment, null, 2) + '\n');
  if (args.plan) { console.log(JSON.stringify(experiment, null, 2)); return experiment; }
  for (const item of configurations) {
    await build(['--variant', 'profile-gpu', '--patches', item.groupArgument, ...workArgument]);
  }
  return profile(profileArgs);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  profileH8().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
