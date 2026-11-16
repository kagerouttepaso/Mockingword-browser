// tools/page-replay.mjs の1回分を、時間軸に並べて区間ごとに分ける。
// 入力はすべてエポックからのミリ秒にそろえる。
//   t0        … ページへ「訳す」を送った時刻
//   firstLine … 訳文が最初にページへ入った時刻（null 可）
//   consoles  … ページのコンソールの LOG_TAG（shared/messages.js）の行 [{ t, text }]（CDP の timestamp）
//   traces    … 調査用のログ（Service Workerの logs。time は ISO、Service Workerが受け取った時刻）
//   steps     … 計測版 wllama の step（perf-trace.mjs の analyzeEvents().steps。無ければ []）
//   parallel  … 同時実行数

import { LOG_SOURCE } from '../../extension/shared/messages.js';
import { kernelCategory } from './gpu-timing.mjs';

const at = (entry) => Date.parse(entry.time);
const round = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v));
const chunkId = (requestId) => Number(/:(\d+)$/.exec(requestId ?? '')?.[1] ?? NaN);

/** 区間 [start, end) の集まりについて、各時刻に重なっている数の時間平均と、数ごとの時間を返す。 */
export function overlap(intervals, from, to) {
  const edges = [];
  for (const { start, end } of intervals) {
    const s = Math.max(start, from), e = Math.min(end, to);
    if (e > s) edges.push([s, 1], [e, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const byCount = {};
  let level = 0, last = from, area = 0;
  for (const [t, d] of edges) {
    if (t > last) { byCount[level] = (byCount[level] ?? 0) + (t - last); area += level * (t - last); }
    level += d; last = Math.max(last, t);
  }
  if (to > last) byCount[level] = (byCount[level] ?? 0) + (to - last);
  return { mean: to > from ? area / (to - from) : 0, byCount: Object.fromEntries(Object.entries(byCount).map(([k, v]) => [k, round(v)])) };
}

/** offscreen の「生成」1件を、開始・生成開始・最初の字・終了の時刻に直す。 */
export function generation(entry) {
  const start = entry.startAt;
  const entered = start + (entry.loadMs ?? 0) + (entry.waitMs ?? 0);
  const first = entry.firstMs === null || entry.firstMs === undefined ? null : start + entry.loadMs + entry.firstMs;
  const end = (first ?? start + (entry.loadMs ?? 0)) + (entry.genMs ?? 0);
  return { id: chunkId(entry.requestId), start, entered, first, end, tokens: entry.tokens ?? null, promptTokens: entry.promptTokens ?? null, chars: entry.chars };
}

/** step を区間ごとにまとめる。行数（入力トークン数）が直前の step と変わった step も数える。 */
export function stepSummary(steps, from, to) {
  const inside = steps.filter((s) => s.startMs >= from && s.endMs <= to).sort((a, b) => a.startMs - b.startMs);
  if (!inside.length) return null;
  const phases = {};
  for (const s of inside) {
    const p = (phases[s.phase] ??= { steps: 0, ms: 0, inputTokens: 0, sampledTokens: 0 });
    p.steps++; p.ms += s.ms; p.inputTokens += s.tokens; p.sampledTokens += s.sampledTokens ?? 0;
  }
  const rows = {};
  let changed = 0, changedMs = 0, steadyMs = 0, steadySteps = 0;
  for (let i = 0; i < inside.length; i++) {
    const s = inside[i];
    if (s.phase !== 'decode') continue;
    const r = (rows[s.tokens] ??= { steps: 0, ms: 0 });
    r.steps++; r.ms += s.ms;
    const prev = inside[i - 1];
    if (prev && prev.tokens !== s.tokens) { changed++; changedMs += s.ms; } else { steadySteps++; steadyMs += s.ms; }
  }
  let gapMs = 0;
  for (let i = 1; i < inside.length; i++) gapMs += Math.max(0, inside[i].startMs - inside[i - 1].endMs);
  const stepMs = inside.reduce((sum, s) => sum + s.ms, 0);
  const sampled = inside.reduce((sum, s) => sum + (s.sampledTokens ?? 0), 0);
  // 計測版 profile-gpu のときだけ、step の種類ごとに GPU のカーネルの時間を種類別に足す（gpu-timing.mjs と同じ分け方）。
  const gpu = {};
  const pipelines = {};
  for (const s of inside) for (const [name, v] of Object.entries(s.gpu ?? {})) {
    const byPhase = (gpu[s.phase] ??= { totalMs: 0, prefillTokens: 0, categories: {} });
    const c = (byPhase.categories[kernelCategory(name)] ??= { ms: 0, count: 0 });
    c.ms += v.ms; c.count += v.count; byPhase.totalMs += v.ms;
    const p = ((pipelines[s.phase] ??= {})[name] ??= { ms: 0, count: 0 });
    p.ms += v.ms; p.count += v.count;
  }
  for (const s of inside) if (gpu[s.phase]) gpu[s.phase].prefillTokens += s.prefillTokens ?? 0;
  const gpuSummary = Object.keys(gpu).length ? Object.fromEntries(Object.entries(gpu).map(([phase, v]) => [phase, {
    totalMs: round(v.totalMs), prefillTokens: v.prefillTokens,
    categories: Object.fromEntries(Object.entries(v.categories).sort((a, b) => b[1].ms - a[1].ms).map(([k, c]) => [k, { ms: round(c.ms), count: c.count }])),
    topPipelines: Object.entries(pipelines[phase]).sort((a, b) => b[1].ms - a[1].ms).slice(0, 6).map(([name, c]) => ({ name, ms: round(c.ms), count: c.count })),
  }])) : null;
  return {
    gpu: gpuSummary,
    steps: inside.length,
    spanMs: round(inside.at(-1).endMs - inside[0].startMs),
    stepMs: round(stepMs),
    gapMs: round(gapMs),
    beforeFirstStepMs: round(inside[0].startMs - from),
    sampledTokens: sampled,
    tokensPerSecondInSteps: stepMs ? +((sampled / stepMs) * 1000).toFixed(1) : null,
    phases: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, { ...v, ms: round(v.ms) }])),
    decodeRows: Object.entries(rows).map(([k, v]) => ({ rows: Number(k), steps: v.steps, ms: round(v.ms), msPerStep: +(v.ms / v.steps).toFixed(2) })).sort((a, b) => a.rows - b.rows),
    decodeRowChange: { steps: changed, ms: round(changedMs), msPerStep: changed ? +(changedMs / changed).toFixed(2) : null, steadyMsPerStep: steadySteps ? +(steadyMs / steadySteps).toFixed(2) : null },
  };
}

export function analyzeReplay({ t0, firstLine, consoles, traces, steps = [], parallel }) {
  const sends = traces.filter((e) => e.event === '送信').map((e) => ({ id: e.id, t: at(e), lines: e.lines, chars: e.chars, screen: e.screen ?? 0 }));
  const recvs = new Map(traces.filter((e) => ['受信', '取り消し済み', '失敗'].includes(e.event)).map((e) => [e.id, at(e)]));
  const gens = traces.filter((e) => e.source === LOG_SOURCE.model && e.event === '生成' && e.startAt).map(generation).sort((a, b) => a.start - b.start);
  const findLog = (re) => consoles.find((c) => re.test(c.text));
  const collected = findLog(/段落 \d+ 件を訳し始めます/);
  const screenLog = findLog(/画面内の訳し終わり/);
  const doneLog = findLog(/全体の訳し終わり/);
  const end = doneLog?.t ?? Math.max(...[...recvs.values(), t0]);
  const rel = (t) => round(t === null || t === undefined ? null : t - t0);

  // 最初の行：開始 → 段落を集め終わる → 最初の送信 → モデルが受け取る → 最初の字 → ページに出る
  const firstSend = sends[0];
  const firstGen = gens.find((g) => g.id === firstSend?.id) ?? gens[0];
  const firstLineBreakdown = {
    collectedMs: rel(collected?.t),
    firstSendMs: rel(firstSend?.t),
    modelEnteredMs: rel(firstGen?.entered),
    firstTokenMs: rel(firstGen?.first),
    firstLineMs: rel(firstLine),
    firstChunk: firstSend ? { lines: firstSend.lines, chars: firstSend.chars, promptTokens: firstGen?.promptTokens, tokens: firstGen?.tokens } : null,
  };

  // 画面内：画面内の段落を含むバッチが、いつ送られ、その前にほかのバッチが何本送られたか
  const screenSends = sends.filter((s) => s.screen > 0);
  const lastScreen = screenSends.at(-1);
  const screen = {
    doneMs: rel(screenLog?.t),
    chunks: screenSends.length,
    paragraphs: screenSends.reduce((sum, s) => sum + s.screen, 0),
    lastScreenChunkSentMs: rel(lastScreen?.t),
    lastScreenChunkDoneMs: rel(lastScreen ? recvs.get(lastScreen.id) : null),
    nonScreenChunksBeforeLast: lastScreen ? sends.filter((s) => s.t <= lastScreen.t && s.screen === 0).length : 0,
    chunksBeforeLast: lastScreen ? sends.filter((s) => s.t <= lastScreen.t).length : 0,
  };

  // 送信：ページ側の送信中の同時実行数と、モデルが生成している同時実行数の時間平均
  const from = firstSend?.t ?? t0;
  const pageInflight = overlap(sends.map((s) => ({ start: s.t, end: recvs.get(s.id) ?? end })), from, end);
  const generating = overlap(gens.map((g) => ({ start: g.entered, end: g.end })), from, end);
  const flow = {
    totalMs: rel(end),
    chunks: sends.length,
    completions: gens.length,
    promptTokens: gens.reduce((sum, g) => sum + (g.promptTokens ?? 0), 0),
    tokens: gens.reduce((sum, g) => sum + (g.tokens ?? 0), 0),
    meanPageInflight: +pageInflight.mean.toFixed(2),
    meanGenerating: +generating.mean.toFixed(2),
    generatingByCount: generating.byCount,
    parallel,
  };
  return { firstLine: firstLineBreakdown, screen, flow, steps: stepSummary(steps, from, end) };
}

const s = (ms) => (ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(2) + '秒');
export function formatReplay(a) {
  const f = a.firstLine, sc = a.screen, fl = a.flow;
  const lines = [
    `  最初の行：段落集め ${s(f.collectedMs)} → 最初の送信 ${s(f.firstSendMs)} → モデルが受け取る ${s(f.modelEnteredMs)} → 最初の字 ${s(f.firstTokenMs)} → ページに出る ${s(f.firstLineMs)}` +
      (f.firstChunk ? `（最初のバッチ ${f.firstChunk.lines}行・${f.firstChunk.chars}字・入力 ${f.firstChunk.promptTokens ?? '—'}トークン・出力 ${f.firstChunk.tokens ?? '—'}トークン）` : ''),
    `  画面内：${s(sc.doneMs)}。画面内の段落 ${sc.paragraphs}件は ${sc.chunks}バッチ、最後のバッチは ${sc.chunksBeforeLast}本目（うち画面外 ${sc.nonScreenChunksBeforeLast}本）で ${s(sc.lastScreenChunkSentMs)} に送り ${s(sc.lastScreenChunkDoneMs)} に返った`,
    `  送信：全体 ${s(fl.totalMs)}、バッチ ${fl.chunks}本・生成 ${fl.completions}回、入力 ${fl.promptTokens}・出力 ${fl.tokens}トークン。平均の送信中 ${fl.meanPageInflight}本・生成中 ${fl.meanGenerating}本（上限 ${fl.parallel}本）`,
    `    生成中の本数ごとの時間：${Object.entries(fl.generatingByCount).map(([k, v]) => `${k}本 ${s(v)}`).join('、')}`,
  ];
  const st = a.steps;
  if (st) {
    lines.push(`  step：${st.steps}回、step の中 ${s(st.stepMs)}・step の間 ${s(st.gapMs)}・最初の step まで ${s(st.beforeFirstStepMs)}、step の中の速さ ${st.tokensPerSecondInSteps} tok/s`);
    lines.push(`    種類：${Object.entries(st.phases).map(([k, v]) => `${k} ${v.steps}回・${s(v.ms)}`).join('、')}`);
    lines.push(`    decode の行数：${st.decodeRows.map((r) => `${r.rows}行 ${r.steps}回×${r.msPerStep}ms`).join('、')}`);
    lines.push(`    行数が変わった直後の decode：${st.decodeRowChange.steps}回・${s(st.decodeRowChange.ms)}（1回 ${st.decodeRowChange.msPerStep}ms、変わらない step は ${st.decodeRowChange.steadyMsPerStep}ms）`);
    for (const [phase, g] of Object.entries(st.gpu ?? {})) {
      lines.push(`    GPU（${phase}）：計 ${s(g.totalMs)}${g.prefillTokens ? `・読み込み ${g.prefillTokens}トークン` : ''}　${Object.entries(g.categories).map(([k, c]) => `${k} ${s(c.ms)}`).join('、')}`);
      lines.push(`      上位：${g.topPipelines.map((p) => `${p.name} ${p.ms}ms×${p.count}`).join('、')}`);
    }
  }
  return lines.join('\n');
}
