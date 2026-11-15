import { performance } from 'node:perf_hooks';

// 工程は親子で重なることがある。合計と各工程を別に残し、単純加算で総時間を作らない。
export class Timings {
  constructor() { this.start = performance.now(); this.rows = []; }
  async phase(name, task) {
    const start = performance.now();
    try { return await task(); }
    finally { this.rows.push({ name, ms: performance.now() - start }); }
  }
  snapshot() { return { totalMs: performance.now() - this.start, phases: this.rows }; }
  print(prefix = '') {
    for (const row of this.rows) console.log(`${prefix}${row.name}: ${(row.ms / 1000).toFixed(3)}秒`);
    console.log(`${prefix}全体: ${(this.snapshot().totalMs / 1000).toFixed(3)}秒`);
  }
}
