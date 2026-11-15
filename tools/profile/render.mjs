// 取得済みのJSONから表だけを作り直す。モデルの再取得・再計測を行わない。
import fs from 'node:fs';
import path from 'node:path';
import { formatSummary } from './report.mjs';
import { analyzeEvents, decodeStepBreakdown, stepOccupancy } from '../lib/perf-trace.mjs';
import { analyzeGpuEvents } from './gpu-timing.mjs';
const args = process.argv.slice(2), value = (name) => args[args.indexOf(name) + 1];
if (!args.includes('--report')) throw new Error('--report FILE を指定してください');
const report = JSON.parse(fs.readFileSync(value('--report'), 'utf8'));
for (const run of report.runs) if (run.profile) {
  run.profile.occupancy ??= [];
  run.profile.decodeBreakdown ??= [];
  run.profile.gpuTiming = [];
  for (let index = 0; index < 3; ++index) {
    const prefix = run.caseId ? `${run.caseId}-${run.model}-visit${run.visit}` : `${run.variant}-${run.model}`;
    const file = path.join(path.dirname(value('--report')), `${prefix}-round${index + 1}.json`);
    if (fs.existsSync(file)) {
      const round = JSON.parse(fs.readFileSync(file, 'utf8'));
      const events = round.events ?? [];
      const steps = round.analysis?.steps ?? analyzeEvents(events).steps;
      run.profile.occupancy[index] ??= stepOccupancy(steps);
      run.profile.decodeBreakdown[index] = decodeStepBreakdown(steps);
      run.profile.gpuTiming[index] = analyzeGpuEvents(events);
      run.profile.gpu ??= [];
      run.profile.gpu[index] = run.profile.gpuTiming[index].pipelines;
    }
  }
}
const summary = formatSummary(report);
// 再計測せず、古い round JSON からも step 別 GPU 合計を持ち出せる。
if (args.includes('--gpu-output')) fs.writeFileSync(value('--gpu-output'), JSON.stringify(report.runs.map((run) => ({
  caseId: run.caseId ?? run.variant, model: run.model, visit: run.visit ?? 0, rounds: run.profile?.gpuTiming ?? [],
})), null, 2) + '\n');
if (args.includes('--output')) fs.writeFileSync(value('--output'), summary);
else console.log(summary);
