// 拡張機能のOffscreen Document。ブラウザーの中で PLaMo を動かす（wllama＝llama.cpp の WASM 版）。
// Service Worker（core/engine.js）から { target: 'offscreen' } のリクエストを受けて訳す。モデルは一度読み込んだら、このページが閉じるまで保持する。
// メモリーを空けるときは、Service Workerがこのページごと閉じる（未使用が続いたとき・「モデルを解放」）。設計は docs/03_翻訳コア.md。
import { LogLevel, Wllama } from '../vendor/wllama/index.js';
import { runaway } from '../shared/text.js';
import { previewLine } from '../shared/markup.js';
import { LOG_SOURCE, MSG, OFFSCREEN } from '../shared/messages.js';
import { LOCAL_DEFAULTS } from '../shared/settings.js';
import { adapterLabel, chosenAdapter, gpuView, isEngineCrash, parseGpuReport, reportSummary } from './gpu.js';

/**
 * 取得元は版（コミット）に固定する。配布元はチャットテンプレートだけを何度も更新しており、main から取ると中身が変わる。
 * 初回だけ取得し、wllama が OPFS（拡張機能の中のファイル置き場）に保存する。
 */
const MODELS = {
  '0.8B': {
    url: 'https://huggingface.co/pfnet/plamo-3-translate-0.8b-GGUF/resolve/e10c327b7a7ce84ffc427cb4b09360b781429fda/plamo-3-translate-0.8b-Q4_K_M.gguf',
    size: 573126848,
  },
  '2B': {
    url: 'https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF/resolve/232fbd7916519edecddfdae0beae7e76fe70453f/plamo-3-translate-2b-Q4_K_M.gguf',
    size: 1807199392,
  },
};

/** 推論エンジン（wllama の WASM）。 */
const WASM_URL = chrome.runtime.getURL('vendor/wllama/wasm/wllama.wasm');

/** 1スロット（同時に訳す1本）あたりの文脈の長さ（トークン）。 */
const CTX_PER_SLOT = 4096;

// ---------------- モデルの読み込み ----------------

/** 今読み込んでいるモデル。{ key, name, device, threads, parallel, ubatch, adapter, gpu, gpuAt, fallback, native, wllama, ready: Promise }。gpu は GPU で読み込んだときの推論エンジンの報告 */
let current = null;

/**
 * GPU の計算が止まった記録。{ reason, error }。自動のモードは、このOffscreen Documentが閉じるまで GPU を使わない
 * （同じ GPU で読み込み直しても同じ所で止まるため）。閉じると（未使用が続いたとき・「モデルを解放」）消え、次は GPU を試す。
 */
let gpuFailure = null;

/** 推論エンジンのログのうち、調査用のログに添える警告・エラーの行数。 */
const NATIVE_LINES = 20;

/**
 * 推論エンジンのログの受け取り口。GPU の報告（./gpu.js）と、警告・エラーの最後の数行だけを残す。
 * GPU の選択・検算の結果も、計算が止まったときの理由も、ここで受け取ったものしか使わない。
 */
function nativeLog() {
  const native = { report: null, lines: [], crashed: false };
  const keep = (level) => (...args) => {
    const line = args.map(String).join(' ');
    const report = parseGpuReport(line);
    if (report) {
      native.report = report;
      return;
    }
    if (level === 'debug') return;
    if (line.includes('Stack trace (abort)')) native.crashed = true; // wllama が WASM の停止を知らせる行
    native.lines.push(line.slice(0, 300));
    if (native.lines.length > NATIVE_LINES) native.lines.shift();
  };
  native.logger = { debug: keep('debug'), log: keep('log'), info: keep('log'), warn: keep('warn'), error: keep('error') };
  return native;
}

/** CPU のスレッド数。0（自動）なら論理コア数の半分（wllama の既定と同じ。残りを画面の処理に空ける）。 */
function threadsFor(requested) {
  const cores = navigator.hardwareConcurrency || 1;
  return requested > 0 ? Math.min(requested, cores) : Math.max(1, Math.floor(cores / 2));
}

/**
 * slots：同時に計算できる同時実行数（ページの同時送信数＋1。1本を選択範囲・テキスト翻訳に空ける）。
 * ubatch：原文の読み込みで GPU へ一度に渡すトークン数。n_batch はそれ以上にする必要がある。
 */
async function load(name, device, threads, slots, ubatch) {
  const native = nativeLog();
  const wllama = new Wllama({ default: WASM_URL }, { logger: native.logger });
  let lastReport = 0;
  try {
    await loadInto(wllama, name, device, threads, slots, ubatch, (now) => {
      if (now - lastReport < 500) return false;
      lastReport = now;
      return true;
    });
  } catch (e) {
    // 読み込みに失敗した分の GPU メモリーを空けてから、呼び出し元が同時実行数を下げて試し直す。
    await wllama.exit().catch(() => {});
    e.native = native;
    throw e;
  }
  return { wllama, native };
}

async function loadInto(wllama, name, device, threads, slots, ubatch, due) {
  await wllama.loadModelFromUrl(MODELS[name].url, {
    useCache: true,
    // GPU の報告は推論エンジンの起動時に出るので、この値に関わらず届く。読み込み後は警告・エラーだけを受け取る。
    log_level: LogLevel.WARN,
    n_gpu_layers: device === 'gpu' ? 99 : 0, // 0 にすると WebGPU を使わず CPU（WASM）で動く
    n_threads: threads,
    n_ctx: CTX_PER_SLOT * slots,
    n_batch: Math.max(2048, ubatch),
    n_ubatch: ubatch,
    n_parallel: slots,
    // PLaMo 3 の SWA（窓2048）の層の KV を、窓の大きさに切り詰めず全長で持つ。見える範囲は変わらない（1回のリクエストは窓に収まる）が、
    // 原文の読み込みが速くなる。sakutto（同じ PLaMo＋wllama の拡張機能）の知見で、この検証環境A（RTX 4060）でも
    // 8バッチが2.65→2.35秒、最初の1バッチが1.07→0.94秒になった（2026-11-09、2巡とも同じ傾向）。
    swa_full: true,
    progressCallback: ({ loaded, total }) => {
      if (!due(Date.now()) && loaded < total) return;
      chrome.runtime.sendMessage({ type: MSG.MODEL_PROGRESS, model: name, loaded, total: total || MODELS[name].size }).catch(() => {});
    },
  });
}

/** GPU で試す同時実行数の順。指定の同時実行数から4本・1本へ下げる（指定より多くはしない）。 */
function degradeSteps(parallel) {
  return [...new Set([parallel, 4, 1])].filter((n) => n <= parallel);
}

/**
 * 同時に計算させるリクエストを、読み込めたスロット数までに抑える。
 * ページは設定の同時実行数で送ってくるので、同時実行数を下げて読み込んだときは、あふれたリクエストをここで順番に待たせる。
 */
async function acquire(entry) {
  entry.active ??= 0;
  entry.waiters ??= [];
  if (entry.active >= entry.slots) await new Promise((resolve) => entry.waiters.push(resolve));
  entry.active++;
  return () => {
    entry.active--;
    entry.waiters.shift()?.();
  };
}

/** 指定のモデル・動作モードで読み込んだものを返す。違うものを読み込んでいたら、空けてから読み込み直す。 */
async function ensure(message) {
  const { model, device = LOCAL_DEFAULTS.device, threads = LOCAL_DEFAULTS.threads, parallel = LOCAL_DEFAULTS.parallel, ubatch = LOCAL_DEFAULTS.ubatch } = message;
  const key = `${model}|${device}|${threads}|${parallel}|${ubatch}`;
  if (current?.key === key) {
    const same = current;
    return same.ready.then(() => same);
  }
  const previous = current;
  const entry = { key, name: model, device: null, threads: null, parallel, ubatch, adapter: null, gpu: null, gpuAt: null, fallback: null, native: null, wllama: null, ready: null };
  current = entry;
  entry.ready = (async () => {
    // 別のモデル・設定に切り替えるときは、メモリー（2Bで約2GB）を空けてから読み込む。
    if (previous) await previous.ready.catch(() => {}).then(() => previous.wllama?.exit()).catch(() => {});
    // どの GPU を使うか・使えるかは推論エンジンが決めて報告する（./gpu.js）。ここでは GPU を求めない。
    const useGpu = device === 'gpu' || (device === 'auto' && !gpuFailure);
    entry.threads = threadsFor(threads);
    let error = null;
    if (useGpu) {
      // GPU で読み込めないとき（内蔵GPUのメモリー不足など）は、すぐ CPU へ落とさず同時実行数を下げて試す。
      // GPU の4本・1本でも CPU より約2〜7倍速い（docs/03「動作モード」）。sakutto の段階的な降格と同じ考え方（docs/09 S4）。
      for (const n of degradeSteps(parallel)) {
        try {
          const loaded = await load(model, 'gpu', entry.threads, n + 1, ubatch);
          const report = loaded.native.report;
          trace(message, 'GPU', { ...reportSummary(report), parallel: n, native: loaded.native.lines.slice(-8) });
          entry.wllama = loaded.wllama;
          entry.native = loaded.native;
          entry.gpu = report;
          entry.gpuAt = Date.now();
          entry.slots = n + 1;
          if (report && !report.ready) {
            // 推論エンジンが GPU を使えないと判断した（検算の不一致・shader-f16 なし・デバイスを取れない）。
            // モデルは CPU に載っており、同時実行数も CPU と同じなので、自動ならこのまま CPU として使う。
            if (device !== 'auto') {
              await loaded.wllama.exit().catch(() => {});
              entry.wllama = null;
              error = new Error(`GPU を使えません（${report.error ?? '理由不明'}）。動作モードを自動か CPU にしてください。`);
              break;
            }
            entry.device = 'cpu';
            entry.fallback = `GPU を使えないため（${report.error ?? '理由不明'}）`;
            break;
          }
          entry.device = 'gpu';
          entry.adapter = adapterLabel(chosenAdapter(report));
          if (n !== parallel) console.warn(`[Mockingword] GPUで同時${parallel}本を読み込めないため、${n}本で読み込みました`, error);
          break;
        } catch (e) {
          trace(message, 'GPU読み込み失敗', { ...reportSummary(e.native?.report), parallel: n, error: e?.message ?? String(e), native: e.native?.lines.slice(-8) ?? [] });
          entry.gpu = e.native?.report ?? entry.gpu;
          entry.gpuAt = Date.now();
          error = e;
        }
      }
    }
    if (!entry.wllama) {
      // GPU を明示した設定なら CPU へは落とさない。自動なら CPU で読み込み直す（WebGPU の不具合に備える）。
      if (useGpu && device !== 'auto') throw error;
      if (useGpu) console.warn('[Mockingword] GPUで読み込めないためCPUで読み込みます', error);
      const loaded = await load(model, 'cpu', entry.threads, parallel + 1, ubatch);
      entry.wllama = loaded.wllama;
      entry.native = loaded.native;
      entry.device = 'cpu';
      entry.slots = parallel + 1;
      entry.fallback = device !== 'auto' ? null : gpuFailure?.reason ?? (useGpu ? 'GPU で読み込めないため' : null);
    }
  })();
  entry.ready.catch(() => {
    if (current === entry) current = null; // 失敗したら次のリクエストで読み込み直す
  });
  await entry.ready;
  return entry;
}

/** 読み込みの状態。読み込みの途中なら loading。 */
async function status() {
  if (!current) return { ok: true, loaded: null };
  const done = await Promise.race([current.ready.then(() => true, () => false), new Promise((r) => setTimeout(() => r(null), 0))]);
  if (done === null) return { ok: true, loaded: null, loading: current.name };
  if (!done || !current.wllama) return { ok: true, loaded: null };
  return {
    ok: true,
    loaded: current.name,
    device: current.device,
    threads: current.device === 'cpu' ? (current.wllama.isMultithread() ? current.threads : 1) : null,
    adapter: current.adapter,
    gpu: current.gpu ? { ...gpuView(current.gpu), at: current.gpuAt, source: 'loaded', crashed: gpuFailure?.reason ?? null } : null,
    fallback: current.fallback, // 自動のモードで CPU になった理由（GPU を使えない・計算が止まった）。無ければ null
    parallel: current.slots - 1, // GPU で同時実行数を下げて読み込んだときは、実際に読み込めた同時実行数
    ubatch: current.ubatch,
  };
}

/**
 * 使う GPU を確かめる（設定画面を開いたとき・「確かめ直す」）。
 * モデルを読み込み済みなら、読み込んだときの報告を返す（そのモデルが実際に使っている GPU）。
 * 読み込んでいなければ、モデルなしで推論エンジンを起動して報告を受け取る（wllama の probeBackend。数秒で、何も取得しない）。
 * どちらも推論エンジンの同じ起動の処理の報告で、拡張機能は GPU を自分で求めない。
 */
async function checkGpu() {
  const entry = current;
  if (entry) await entry.ready.catch(() => {});
  if (current === entry && entry?.gpu) {
    return { ok: true, ...gpuView(entry.gpu), at: entry.gpuAt, source: 'loaded', crashed: gpuFailure?.reason ?? null, native: entry.native?.lines.slice(-8) ?? [] };
  }
  const native = nativeLog();
  const wllama = new Wllama({ default: WASM_URL }, { logger: native.logger });
  try {
    await wllama.probeBackend();
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e), ...gpuView(native.report), at: Date.now(), source: 'probe', native: native.lines.slice(-8) };
  }
  return { ok: true, ...gpuView(native.report), at: Date.now(), source: 'probe', crashed: gpuFailure?.reason ?? null, report: reportSummary(native.report), native: native.lines.slice(-8) };
}

// ---------------- 生成 ----------------

/** 生成中のリクエスト。番号 → 中止の仕掛け。Service Workerからの取り消しで止める。 */
const running = new Map();

/** 調査用のログをService Workerへ送る（設定の「調査用のログ」がオンのときだけ）。 */
function trace(message, event, data) {
  if (message.debugLog) chrome.runtime.sendMessage({ type: MSG.LOG, source: LOG_SOURCE.model, event, data }).catch(() => {});
}

/**
 * 1回の生成。少しずつ受け取り、止まらなくなったら（shared/text.js の runaway）打ち切って、繰り返した部分を捨てる。
 * 取り消されたら { ok:false, cancelled:true }。打ち切りも取り消しも、wllama の中止ですぐに計算が止まる。
 */
async function complete(message) {
  const controller = new AbortController();
  const key = message.requestId ?? Symbol();
  if (!running.has(key)) running.set(key, new Set());
  running.get(key).add(controller);
  try {
    return await generate(message, controller);
  } catch (e) {
    // GPU の計算が止まったら、自動のモードでは CPU で読み込み直して1回だけ訳し直す（ensure が gpuFailure を見て CPU を選ぶ）。
    if (e?.gpuCrash && (message.device ?? LOCAL_DEFAULTS.device) === 'auto' && !controller.signal.aborted) return await generate(message, controller);
    throw e;
  } finally {
    running.get(key)?.delete(controller);
    if (running.get(key)?.size === 0) running.delete(key);
  }
}

/**
 * GPU で計算中に推論エンジンが止まったとき（WASM ごと止まり、そのモデルは使えない）。原因を調査用のログに残し、
 * 読み込み直せるように今のモデルを外す。返すエラーは gpuCrash の印を持ち、complete が自動のモードなら CPU で訳し直す。
 */
function gpuCrashed(entry, error, message) {
  if (!gpuFailure) {
    gpuFailure = { reason: `GPU（${entry.adapter ?? '名前不明'}）の計算が止まったため`, error: error?.message ?? String(error) };
    trace(message, 'GPU失敗', { adapter: entry.adapter, error: gpuFailure.error, native: entry.native?.lines.slice(-8) ?? [] });
    console.warn('[Mockingword] GPUの計算が止まりました', gpuFailure.error, entry.native?.lines ?? []);
  }
  if (current === entry) current = null;
  if (!entry.exiting) entry.exiting = entry.wllama?.exit().catch(() => {});
  const e = new Error(`GPU の計算が止まりました（${entry.adapter ?? '名前不明'}）。動作モードを自動か CPU にしてください。`);
  e.gpuCrash = true;
  return e;
}

async function generate(message, controller) {
  const t0 = performance.now();
  const entry = await ensure(message);
  if (controller.signal.aborted) return { ok: false, cancelled: true };
  const wllama = entry.wllama;
  const loaded = performance.now();
  let text = '';
  let keep = 0;
  let usage = null;
  let first = 0;
  // Web・PDFの翻訳は、完了した行と最後の行の文末までを、変化したときだけ0.25秒おきまでに知らせる。
  // stream（テキスト翻訳）は行の区切りを待たず0.1秒おきに、生成したトークン数（受け取った回数）も添えて知らせる。
  let lastPartial = -Infinity;
  let sent = '';
  let pieces = 0;
  const partial = () => {
    const now = performance.now();
    if (now - lastPartial < (message.stream ? 100 : 250)) return;
    lastPartial = now;
    const snapshot = message.stream ? text : pagePreview();
    if (!message.stream && snapshot === sent) return;
    sent = snapshot;
    chrome.runtime.sendMessage({ type: MSG.PARTIAL, requestId: message.requestId, text: snapshot,
      pageRows: message.pageRows, previewId: message.previewId, tokens: pieces }).catch(() => {});
  };
  const pagePreview = () => {
    const lines = text.split('\n');
    return lines.slice(0, message.pageRows.length + 1).map((line, i) =>
      i < message.pageRows.length ? previewLine(line, i < lines.length - 1).text : '').join('\n');
  };
  // 同時実行数を下げて読み込んだときは、ここで空きを待つ。待つ間に取り消されたら生成しない。
  const release = await acquire(entry);
  const acquired = performance.now();
  try {
    if (controller.signal.aborted) throw new Error('取り消し済み');
    await wllama.createCompletion({
      // この経路は温度0固定の翻訳だけ。token-only は自前ビルドの sampling パッチが受け持つ。
      backend_sampling: true,
      backend_sampling_token_only: true,
      samplers: ['temperature'],
      // 速さの調整は同じ文章を繰り返し訳すので、キャッシュ（読み込み済みの原文）を使うと原文の読み込みが省かれ、実際のページより速く出る。
      // 調整のときだけ切る。ページの翻訳は毎回違う文なので、既定（キャッシュあり）のまま。
      ...(message.noCache ? { cache_prompt: false } : {}),
      prompt: message.prompt,
      max_tokens: message.maxTokens,
      temperature: 0,
      stop: message.stop,
      stream: true,
      abortSignal: controller.signal,
      onData: (chunk) => {
        first ||= performance.now();
        pieces++;
        text += chunk.choices?.[0]?.text ?? chunk.content ?? '';
        usage = chunk.usage ?? usage;
        if (!keep && (keep = runaway(text, message.lines, message.sourceChars))) controller.abort();
        else if (message.pageRows || message.stream) partial();
      },
    });
  } catch (e) {
    if (!keep && !controller.signal.aborted) {
      if (entry.device === 'gpu' && (entry.native?.crashed || isEngineCrash(e))) throw gpuCrashed(entry, e, message);
      throw e;
    }
  } finally {
    release();
  }
  const data = {
    requestId: message.requestId,
    // 読み込み待ち・最初の1字までの待ち（ほかのリクエストの順番待ちを含む）・生成の時間（ミリ秒）
    // 時間軸に並べるための開始時刻（エポックからのミリ秒）と、同時実行数を下げて読み込んだときの空き待ち
    startAt: Math.round(performance.timeOrigin + t0),
    waitMs: Math.round(acquired - loaded),
    promptTokens: usage?.prompt_tokens,
    loadMs: Math.round(loaded - t0),
    firstMs: first ? Math.round(first - loaded) : null,
    genMs: Math.round(performance.now() - (first || loaded)),
    chars: text.length,
    tokens: usage?.completion_tokens,
    cut: !!keep,
    cancelled: controller.signal.aborted && !keep,
  };
  trace(message, data.cancelled ? '取り消し' : '生成', data);
  if (data.cancelled) return { ok: false, cancelled: true };
  if (keep) {
    // 拡張機能のエラーの一覧に出さないよう info にする（調査用のログには cut として残る）。
    console.info('[Mockingword] 繰り返しが止まらないので打ち切りました', text.slice(-200));
    text = text.slice(0, keep);
  }
  // tokens・genMs は速さの調整（background/tune.js）が、tokens・loadMs はページのバーの速さが使う。
  return { ok: true, text: text.trim(), cut: !!keep, tokens: data.tokens ?? null, genMs: data.genMs, loadMs: data.loadMs };
}

// ---------------- Service Workerからのリクエスト ----------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // ページ側からService Workerへのリクエストもここに届くので、自分宛て以外は返事をしない。
  if (message?.target !== OFFSCREEN) return false;
  const handle = async () => {
    switch (message.type) {
      case MSG.COMPLETE:
        return complete(message);
      case MSG.MODEL_STATUS:
        return status();
      case MSG.MODEL_GPU_CHECK:
        return checkGpu();
      case MSG.MODEL_CANCEL:
        for (const c of running.get(message.requestId) ?? []) c.abort();
        return { ok: true };
    }
    return { ok: false, error: '不明な依頼です。' };
  };
  handle().then(sendResponse, (e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
  return true;
});
