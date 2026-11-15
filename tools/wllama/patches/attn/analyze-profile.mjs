// round JSONから、batch構成とpipeline時間を同じ軸で読み直す。
import fs from 'node:fs';
import path from 'node:path';
const [directory, prefix = 'candidate-'] = process.argv.slice(2);
for (const file of fs.readdirSync(directory).filter(f => f.startsWith(prefix) && /-round\d+\.json$/.test(f)).sort()) {
  const input = JSON.parse(fs.readFileSync(path.join(directory, file)));
  const steps = input.analysis.gpuTiming.steps;
  const groups = {
    prefillMixed: steps.filter(s => s.phase === 'prefill' || s.phase === 'mixed'),
    decode8: steps.filter(s => s.phase === 'decode' && s.tokens === 8),
    decodeAll: steps.filter(s => s.phase === 'decode'),
  };
  for (const [name, selected] of Object.entries(groups)) {
    const pipelines = {};
    for (const step of selected) for (const [n, v] of Object.entries(step.pipelines)) {
      if (!/reg_tile|flash_attn|argsort/.test(n)) continue;
      pipelines[n] ??= { ms: 0, count: 0 };
      pipelines[n].ms += v.ms; pipelines[n].count += v.count;
    }
    console.log(JSON.stringify({ file, name, steps: selected.length, tokens: selected.reduce((a, s) => a + s.tokens, 0),
      gpuMs: selected.reduce((a, s) => a + (s.gpuTotalMs ?? 0), 0),
      batches: name === 'prefillMixed' ? selected.map(s => ({ id: s.decodeStepId, tokens: s.tokens, decodeTokens: s.decodeTokens, hostMs: s.hostMs })) : undefined,
      pipelines }));
  }
}
