// 拡張機能のOffscreen Document。ブラウザーの中で PLaMo を動かす（wllama＝llama.cpp の WASM 版）。
// Service Worker（core/engine.js）から { target: 'offscreen' } のリクエストを受けて訳す。モデルは一度読み込んだら、このページが閉じるまで保持する。
// メモリーを空けるときは、Service Workerがこのページごと閉じる（未使用が続いたとき・「モデルを解放」）。設計は docs/03_翻訳コア.md。
import { Wllama } from '../vendor/wllama/index.js';
import { runaway } from '../shared/text.js';
import { previewLine } from '../shared/markup.js';
import { LOG_SOURCE, MSG, OFFSCREEN } from '../shared/messages.js';
import { LOCAL_DEFAULTS } from '../shared/settings.js';

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

/** 1スロット（同時に訳す1本）あたりの文脈の長さ（トークン）。 */
const CTX_PER_SLOT = 4096;

// ---------------- モデルの読み込み ----------------

/** 今読み込んでいるモデル。{ key, name, device, threads, parallel, ubatch, adapter, wllama, ready: Promise } */
let current = null;

/**
 * WebGPU のアダプター（GPU）の名前。取れなければ null（GPU を使えない）。
 * 単体GPUと内蔵GPUの両方があるPCで、どちらが使われているかを設定画面で確かめるために出す。
 */
async function gpuAdapter() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const i = adapter.info ?? {};
    return [i.description, i.vendor, i.architecture].filter(Boolean).join(' / ') || 'WebGPU';
  } catch {
    return null;
  }
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
  const wllama = new Wllama({ default: chrome.runtime.getURL('vendor/wllama/wasm/wllama.wasm') }, { suppressNativeLog: true });
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
    throw e;
  }
  return wllama;
}

async function loadInto(wllama, name, device, threads, slots, ubatch, due) {
  await wllama.loadModelFromUrl(MODELS[name].url, {
    useCache: true,
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
async function ensure({ model, device = LOCAL_DEFAULTS.device, threads = LOCAL_DEFAULTS.threads, parallel = LOCAL_DEFAULTS.parallel, ubatch = LOCAL_DEFAULTS.ubatch }) {
  const key = `${model}|${device}|${threads}|${parallel}|${ubatch}`;
  if (current?.key === key) {
    const same = current;
    return same.ready.then(() => same);
  }
  const previous = current;
  const entry = { key, name: model, device: null, threads: null, parallel, ubatch, adapter: null, wllama: null, ready: null };
  current = entry;
  entry.ready = (async () => {
    // 別のモデル・設定に切り替えるときは、メモリー（2Bで約2GB）を空けてから読み込む。
    if (previous) await previous.ready.catch(() => {}).then(() => previous.wllama?.exit()).catch(() => {});
    const adapter = device === 'cpu' ? null : await gpuAdapter();
    const useGpu = device === 'gpu' || (device === 'auto' && !!adapter);
    entry.threads = threadsFor(threads);
    let error = null;
    if (useGpu) {
      // GPU で読み込めないとき（内蔵GPUのメモリー不足など）は、すぐ CPU へ落とさず同時実行数を下げて試す。
      // GPU の4本・1本でも CPU より約2〜7倍速い（docs/03「動作モード」）。sakutto の段階的な降格と同じ考え方（docs/09 S4）。
      for (const n of degradeSteps(parallel)) {
        try {
          entry.wllama = await load(model, 'gpu', entry.threads, n + 1, ubatch);
          entry.device = 'gpu';
          entry.adapter = adapter;
          entry.slots = n + 1;
          if (n !== parallel) console.warn(`[Mockingword] GPUで同時${parallel}本を読み込めないため、${n}本で読み込みました`, error);
          break;
        } catch (e) {
          error = e;
        }
      }
    }
    if (!entry.wllama) {
      // GPU を明示した設定なら CPU へは落とさない。自動なら CPU で読み込み直す（WebGPU の不具合に備える）。
      if (useGpu && device !== 'auto') throw error;
      if (useGpu) console.warn('[Mockingword] GPUで読み込めないためCPUで読み込みます', error);
      entry.wllama = await load(model, 'cpu', entry.threads, parallel + 1, ubatch);
      entry.device = 'cpu';
      entry.slots = parallel + 1;
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
    parallel: current.slots - 1, // GPU で同時実行数を下げて読み込んだときは、実際に読み込めた同時実行数
    ubatch: current.ubatch,
  };
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
  const t0 = performance.now();
  const entry = await ensure(message);
  const wllama = entry.wllama;
  const loaded = performance.now();
  const controller = new AbortController();
  const key = message.requestId ?? Symbol();
  if (!running.has(key)) running.set(key, new Set());
  running.get(key).add(controller);
  let text = '';
  let keep = 0;
  let usage = null;
  let first = 0;
  // ページの翻訳は、完了した行と最後の行の文末までを、変化したときだけ0.25秒おきまでに知らせる。
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
      pageRows: message.pageRows, tokens: pieces }).catch(() => {});
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
    if (!keep && !controller.signal.aborted) throw e;
  } finally {
    release();
    running.get(key)?.delete(controller);
    if (running.get(key)?.size === 0) running.delete(key);
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
      case MSG.MODEL_CANCEL:
        for (const c of running.get(message.requestId) ?? []) c.abort();
        return { ok: true };
    }
    return { ok: false, error: '不明な依頼です。' };
  };
  handle().then(sendResponse, (e) => sendResponse({ ok: false, error: e?.message ?? String(e) }));
  return true;
});
