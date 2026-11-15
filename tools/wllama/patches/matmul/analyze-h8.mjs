import fs from 'node:fs';
import path from 'node:path';
import { analyzeGpuEvents } from '../../../profile/gpu-timing.mjs';

// 古いroundは同じ解析器でeventsから再構成し、現在のgpuTiming.stepsと同じ基準で比較する。
export function analyze(root) {
  return fs.readdirSync(root).filter(file => /round\d+\.json$/.test(file)).sort().map(file => {
    const round = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const timing = round.analysis.gpuTiming ?? analyzeGpuEvents(round.events);
    const rows = {};
    for (const step of timing.steps) {
      if (step.phase !== 'decode' || step.status !== 'collected' || ![1, 4, 8].includes(step.tokens)) continue;
      const group = rows[step.tokens] ??= { steps: 0, gpuMs: 0, mmvqMs: 0, pipelines: {} };
      group.steps++;
      group.gpuMs += step.gpuTotalMs;
      group.mmvqMs += step.categories.MMVQ?.ms ?? 0;
      for (const [name, value] of Object.entries(step.pipelines)) {
        if (!name.startsWith('mul_mat_vec_')) continue;
        const item = group.pipelines[name] ??= { count: 0, ms: 0 };
        item.count += value.count;
        item.ms += value.ms;
      }
    }
    for (const group of Object.values(rows)) {
      group.gpuMsPerStep = group.gpuMs / group.steps;
      group.mmvqMsPerStep = group.mmvqMs / group.steps;
      for (const item of Object.values(group.pipelines)) item.msPerDispatch = item.ms / item.count;
    }
    return { file, reconstructed: !round.analysis.gpuTiming, rows };
  });
}
if (process.argv[2]) {
  for (const root of process.argv.slice(2)) console.log(JSON.stringify({ root, rounds: analyze(root) }, null, 2));
}
