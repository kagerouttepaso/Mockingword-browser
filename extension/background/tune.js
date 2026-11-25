// PCの性能に合わせる速さの調整。設定画面の「このPCに合わせる」「今の設定で測る」から使う。
// 同じ量の文章（ページの翻訳と同じ形のバッチ24、キャッシュなし）を、設定を変えて読み込み直したモデルで訳し、かかった時間を比べる。
// キャッシュ（core/cache.js）は通さず、モデルへ直接リクエストる。設計は docs/03_翻訳コア.md「PCに合わせる調整」。

import { complete, status, unload } from '../core/engine.js';
import { LOG_SOURCE, MSG } from '../shared/messages.js';
import { AUTO_PARALLEL_MAX, LOCAL_DEFAULTS, PARALLEL_CHOICES } from '../shared/settings.js';
import { addLog } from './logs.js';

/**
 * 測る文章。ページの翻訳と同じく、1行＝1段落の4行を1バッチにする（1バッチ約200〜260字）。
 * 毎回同じ文章なので、結果を設定どうしで比べられる。
 */
const SAMPLE = [
  ['The quarterly report shows steady growth in all regions.', 'Please review the attached document before the meeting.', 'Our team will deploy the update next Tuesday morning.', 'Contact support if the problem continues after restarting.'],
  ['This setting controls how often the device sends data.', 'You can change the language at any time from the menu.', 'The museum is closed on Mondays and national holidays.', 'Fresh vegetables are delivered to the store every morning.'],
  ['The train to the airport leaves every fifteen minutes.', 'Members can borrow up to ten books at the same time.', 'The new policy applies to all employees from next month.', 'Save your work frequently to avoid losing any changes.'],
  ['The weather forecast predicts heavy rain this weekend.', 'Children under six years old can enter free of charge.', 'The software automatically checks for updates at startup.', 'Thank you for your patience while we fix this issue.'],
  ['The repository contains the source code and documentation.', 'Each pull request must be reviewed by at least one person.', 'Tests run automatically when you push a new commit.', 'Read the contribution guide before opening an issue.'],
  ['The restaurant serves traditional dishes from the region.', 'Reservations are recommended for groups of six or more.', 'The hotel offers free breakfast and a shuttle service.', 'Check-in starts at three in the afternoon.'],
  ['The battery lasts about twelve hours on a single charge.', 'Use only the cable that came with the product.', 'Keep the device away from water and direct sunlight.', 'The warranty covers manufacturing defects for one year.'],
  ['The city plans to build a new library near the station.', 'Volunteers are needed to help clean the park on Sunday.', 'The festival attracts thousands of visitors every summer.', 'Local farmers sell fresh fruit at the weekend market.'],
].map((lines) => lines.join('\n'));

/**
 * 1回に測るバッチ。SAMPLE の行を組み替えて24バッチにする（i 番目の j 行目は (i + j*k) 番目の SAMPLE の j 行目、k = floor(i/8)）。
 * 24 は比べる同時実行数（2・3・4・6・8）のどれでも割り切れるので、どの同時実行数でも最後の巡に端数が出ない。8バッチだと8本だけが1巡で終わり、
 * 3本・6本は端数の巡で不利になっていた（2026-11-10、docs/09「同時実行数の上限」）。すべて別の文なので、キャッシュも効かない。
 */
const LINES = SAMPLE.map((s) => s.split('\n'));
const WORK = Array.from({ length: 24 }, (_, i) => LINES[i % 8].map((_, j) => LINES[(i + j * Math.floor(i / 8)) % 8][j]).join('\n'));

let running = null;
/** 調整の途中か（試している間は、設定の書き換えでモデルを解放しない）。 */
export const tuning = () => running !== null;

/** 設定画面へ途中経過を知らせる。 */
function progress(data) {
  chrome.runtime.sendMessage({ type: MSG.TUNE_PROGRESS, ...data }).catch(() => {});
}

/** 測る回数。1回は数秒なので、中央値を取ってばらつきを抑える。 */
const ROUNDS = 3;

/** バッチ（既定は WORK の24）を parallel 本ずつ同時に訳す1回分。全体の時間と、最初のバッチが返るまでの時間（画面内の目安）を返す。 */
async function round(options, work = WORK) {
  const queue = [...work];
  let tokens = 0;
  let first = 0;
  const t0 = performance.now();
  const worker = async () => {
    while (queue.length) {
      const r = await complete(queue.shift(), options);
      first ||= performance.now() - t0;
      tokens += r.tokens ?? r.text.length;
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.parallel, work.length) }, worker));
  return { ms: performance.now() - t0, first, tokens };
}

const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

/**
 * 1つの設定で測る。読み込みと、同時に訳す形での1回目は時間に含めない。
 * 読み込み直した直後の1回目は、まとめて計算する形の GPU の準備が混ざって1〜2割遅い（2026-11-09、RTX 4060 で同時4本が3.1〜3.5秒、続けて測ると2.7秒）。
 * そのあと ROUNDS 回測って中央値を取り、ばらつき（最大と最小の差÷中央値）も返す。
 */
async function measure(input) {
  // 同じ文章を繰り返すので、キャッシュ（読み込み済みの原文）を切り、毎回原文を読み込ませる（実際のページと同じ条件）。
  // キャッシュありでは検証環境Bの同時8本・8バッチが2.3秒、キャッシュなしでは3.9秒で、原文の読み込みの重さが比較から抜けていた（2026-11-10）。
  const options = { ...input, noCache: true };
  const t0 = performance.now();
  await complete('Warm up the model.', options);
  const loadMs = Math.round(performance.now() - t0);
  const s = await status();
  await round(options, SAMPLE); // ウォームアップは8バッチで足りる（GPU の準備が済めばよい）
  const rs = [];
  for (let i = 0; i < ROUNDS && !running?.stop; i++) rs.push(await round(options));
  if (!rs.length) throw new Error('途中でやめました');
  const ms = Math.round(median(rs.map((r) => r.ms)));
  const tokens = median(rs.map((r) => r.tokens));
  const spread = +((Math.max(...rs.map((r) => r.ms)) - Math.min(...rs.map((r) => r.ms))) / ms).toFixed(3);
  return { device: s.device, adapter: s.adapter ?? null, threads: s.threads ?? null, loadMs, ms, firstMs: Math.round(median(rs.map((r) => r.first))), spread, tokens, tps: +((tokens / ms) * 1000).toFixed(1) };
}

/**
 * 試す設定の並び。最初に shared/settings.js の既定の同時実行数を測り、比べる基準にする。
 * GPU は同時に訳す同時実行数だけを比べる。ubatch は、バッチ1つの原文が約100〜150トークンでほぼ効かないので、今の値のまま（2026-11-09の測定）。
 * CPU はスレッド数と同時実行数。
 */
function* candidates(base, device) {
  if (device === 'cpu') {
    const cores = navigator.hardwareConcurrency || 1;
    for (const threads of [...new Set([Math.max(1, Math.floor(cores / 2)), cores])])
      // 既定を8本へ変えても、現在の4本をCPUの比較候補に残す。
      for (const parallel of [...new Set([LOCAL_DEFAULTS.parallel, 4, 1, 2])]) yield { ...base, threads, parallel };
    return;
  }
  const auto = PARALLEL_CHOICES.filter((p) => p >= 2 && p <= AUTO_PARALLEL_MAX && p !== LOCAL_DEFAULTS.parallel);
  for (const parallel of [LOCAL_DEFAULTS.parallel, ...auto]) yield { ...base, parallel };
}

const label = (o, device) => (device === 'cpu' ? `CPU ${o.threads}スレッド・同時${o.parallel}件` : `同時${o.parallel}件・ubatch ${o.ubatch}`);

/** 今の設定で1回測る。 */
export async function speedTest(options) {
  if (running) throw new Error('調整の途中です。終わるまで待ってください。');
  running = { stop: false };
  try {
    progress({ text: '今の設定で測っています…（モデルの読み込みを含め数十秒）' });
    const r = await measure(options);
    const row = { ...r, parallel: options.parallel, ubatch: options.ubatch, label: label({ ...options, threads: r.threads }, r.device) };
    // 「このPCに合わせる」と同じ形の結果にし、設定画面は同じ表示で出す（違うのは行の数と、選んだ設定が無いことだけ）。
    const result = { at: Date.now(), kind: 'speed', model: options.model, device: r.device, adapter: r.adapter, rows: [row], chosen: null, stopped: false };
    await chrome.storage.local.set({ tuneResult: result });
    addLog(LOG_SOURCE.background, '速さの測定', result);
    return { ok: true, result };
  } finally {
    running = null;
  }
}

/**
 * このPCに合わせる：設定を変えながら測り、いちばん速い設定を chrome.storage.local に保存する。
 * 1つの設定が読み込めない（GPU のメモリー不足など）ときは、その設定を飛ばして続ける。
 */
export async function autoTune(options) {
  if (running) throw new Error('調整の途中です。');
  running = { stop: false };
  const rows = [];
  try {
    const base = { ...options, requestId: undefined, debugLog: false };
    // 最初に今の動作モードで1回読み込み、GPU か CPU かを確かめる（自動で CPU に落ちたときは CPU の調整をする）。
    progress({ text: 'モデルを読み込み、GPU か CPU かを確かめています…', rows });
    await complete('Warm up the model.', base);
    const device = (await status()).device;
    for (const c of candidates(base, device)) {
      if (running.stop) break;
      const name = label(c, device);
      progress({ text: `${name} を測っています…（${rows.length + 1}つ目）`, rows });
      try {
        const r = await measure(c);
        rows.push({ ...r, parallel: c.parallel, ubatch: c.ubatch, threads: device === 'cpu' ? c.threads : null, label: name });
      } catch (e) {
        rows.push({ parallel: c.parallel, ubatch: c.ubatch, threads: c.threads, label: name, error: e?.message ?? String(e) });
      }
      progress({ rows });
    }
    const ok = rows.filter((r) => !r.error);
    let b = [...ok].sort((x, y) => x.ms - y.ms)[0];
    if (!b) throw new Error('どの設定でも測れませんでした。');
    // ばらつきで設定が毎回変わらないよう、既定の同時実行数より、5%と既定の測定のばらつきの大きい方を超えて速いときだけ切り替える。
    const base0 = ok.find((r) => r.parallel === LOCAL_DEFAULTS.parallel && (device !== 'cpu' || r.threads === b.threads));
    if (base0 && b.ms > base0.ms * (1 - Math.max(0.05, base0.spread ?? 0))) b = base0;
    const chosen = { parallel: b.parallel, ubatch: b.ubatch, ...(device === 'cpu' ? { threads: b.threads } : {}) };
    const result = { at: Date.now(), kind: 'tune', model: options.model, device, adapter: rows.find((r) => r.adapter)?.adapter ?? null, rows, chosen, stopped: running.stop };
    await chrome.storage.local.set({ ...chosen, tuneResult: result });
    addLog(LOG_SOURCE.background, 'PCに合わせる調整', result);
    return { ok: true, result };
  } finally {
    running = null;
    await unload(); // 最後に試した設定のまま残さない。次に訳すときに選んだ設定で読み込む
  }
}

/** 調整を途中でやめる（今測っている設定が終わったところで止め、それまでの結果から選ぶ）。 */
export function stopTune() {
  if (running) running.stop = true;
}
