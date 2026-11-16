// 訳す順番と送信。キャッシュにある訳を先に置き換え、残りを優先順とDOMのバッチで数行ずつまとめて、設定の同時実行数まで同時に送る。
// 古くなったバッチ（段落が消えた・文字が変わった）は取り消す。設計は docs/04_ページの翻訳.md「訳す順番と送信」。

import { MSG } from '../shared/messages.js';
import { LOCAL_DEFAULTS, normalizeLocal } from '../shared/settings.js';
import { chunk, groupedChunk, short } from '../shared/text.js';
import { groupOf } from './collect.js';
import { barHasError, barMessage, setBarDone, showBar, updateBar } from './bar.js';
import { clearNotice } from './bubble.js';
import { apply, setWorking } from './write.js';
import { isFront, markReading, onScreen, priority } from './priority.js';
import { debug, log, notify, seconds, send, state, tokensPerSecond, trace } from './state.js';

/** ページの短い項目をDOMのバッチで訳す。交互計測ではここだけfalseにすると従来の8行・400字へ戻る。 */
const GROUP_CHUNKING = true;
/**
 * 同時に送るバッチの数（設定画面の「同時に訳す同時実行数」、PCごと。既定4）。モデルはこれより1本多く同時に計算でき、残り1本を選択範囲・テキスト翻訳に空けておく。
 * 同時に送るとモデルがまとめて計算し、全体が速くなる（llama.cpp のネイティブ版で2Bの4本同時が1本ずつの約2.5倍）。
 */
let workers = LOCAL_DEFAULTS.parallel;
chrome.storage.local.get({ parallel: LOCAL_DEFAULTS.parallel }).then((s) => (workers = normalizeLocal(s).parallel)).catch(() => {});
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.parallel) workers = normalizeLocal({ parallel: c.parallel.newValue }).parallel;
});

const connected = (para) => para.nodes.some((n) => n.isConnected);

/**
 * 同じ文の訳を待っている段落。「世代\n文」→ 段落の集まり。
 * 表の部署名（例：배터리3센터 が何十行も並ぶ）のように同じ文が多いページで、同じ文を何本も同時にモデルへ送らないよう、
 * 1段落だけを送り、残りはここで待たせて、訳が届いたら全部に書き込む。世代を鍵に含め、訳し直し・翻訳の終了の前の待ちと混ぜない。
 */
const waiting = new Map();
const waitKey = (text) => `${state.generation}\n${text}`;

/** 送っているバッチ（今の世代）に含まれる文。 */
function busyTexts() {
  const busy = new Set();
  for (const c of state.chunks.values()) if (c.generation === state.generation) for (const t of c.texts) busy.add(t);
  return busy;
}

/** 訳を待つ段落から、優先度の高い順に1バッチを取り出す。同じ文は1回だけ入れ、残りは訳の届くのを待たせる。 */
function nextChunk() {
  const scored = [];
  for (const para of state.pending) {
    const p = priority(para);
    if (p === Infinity) state.pending.delete(para);
    else scored.push([p, para]);
  }
  scored.sort((a, b) => a[0] - b[0]);
  const busy = busyTexts();
  const candidates = [];
  const unique = new Set(busy);
  for (const [, para] of scored) {
    if (unique.has(para.text)) continue;
    unique.add(para.text);
    if (GROUP_CHUNKING) para.group = groupOf(para.element, para.nodes);
    candidates.push(para);
  }
  if (GROUP_CHUNKING) {
    // 定義のリクエストを選ぶ点数はその組で最も高い段落の点数。リクエストの中はdt→ddのDOM順を守る。
    const definitions = candidates.filter((p) => p.group?.kind === 'definitions');
    definitions.sort((a, b) => {
      const position = a.element.compareDocumentPosition(b.element);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    definitions.forEach((p, order) => (p.group.order = order));
  }
  const selected = (GROUP_CHUNKING ? groupedChunk(candidates, { contextItems: [...state.all, ...candidates] }) : chunk(candidates))[0] ?? [];
  const chosen = new Set(selected);
  for (const para of selected) busy.add(para.text);
  for (const [, para] of scored) {
    if (!chosen.has(para) && busy.has(para.text)) {
      // 同じ文をすでに送っている（このバッチ・送信中のバッチ）。送らずに訳を待つ。
      state.pending.delete(para);
      const key = waitKey(para.text);
      if (!waiting.has(key)) waiting.set(key, new Set());
      waiting.get(key).add(para);
      setWorking([para], true); // 送った段落と同じく、訳している途中として光らせる
    }
  }
  for (const para of selected) state.pending.delete(para);
  return selected;
}

/** 同じ文の訳を待っていた段落を取り出す（送ったバッチの世代のもの）。 */
function takeWaiting(texts, generation) {
  const out = [];
  for (const text of new Set(texts)) {
    const key = `${generation}\n${text}`;
    for (const para of waiting.get(key) ?? []) out.push(para);
    waiting.delete(key);
  }
  return out;
}

/**
 * 段落を訳す列に入れる。キャッシュにある訳は、モデルの順番を待たずに先にまとめて置き換える
 * （ページのキャッシュ→Service Workerのキャッシュ（IndexedDB に残る）の順に引く）。残りだけを訳しに行く。
 */
export async function enqueue(paras) {
  markReading(paras); // 画面内を見出し→第1段落→本文の順に訳すための種類（collect は DOM 順に返す）
  const misses = [];
  for (const para of paras) {
    state.all.add(para);
    const hit = state.cache.get(para.text);
    if (hit !== undefined) apply(para, hit);
    else misses.push(para);
  }
  if (misses.length) {
    const generation = state.generation;
    const r = await send({ type: MSG.CACHE_LOOKUP, texts: misses.map((p) => p.text) }).catch(() => null);
    if (generation !== state.generation) return; // 待つ間に訳し直し・翻訳の終了があった
    let hits = 0;
    misses.forEach((para, i) => {
      const v = r?.results?.[i];
      if (v != null && connected(para)) {
        state.cache.set(para.text, v);
        apply(para, v);
        hits++;
      } else {
        state.pending.add(para);
      }
    });
    if (hits && r?.model) state.model = r.model;
    if (hits && state.firstScreen.size === 0 && state.firstScreenDone === false) state.firstScreenDone = seconds();
    trace('キャッシュ', { asked: misses.length, hits });
  }
  pump();
  finishIfDone();
}

/**
 * 何も送っていない状態から訳し始めるときは、いちばん優先のバッチだけを先に送り、その最初の行が届くか、返事が来てから残りを送る。
 * 全部を同時に送ると、最初のバッチの原文の読み込みがほかの同時実行数分の読み込みと一緒に計算され、最初の行が遅れる
 * （検証環境Bで同時8本の最初の1バッチ 3.3秒、4本で 2.1秒。docs/09「同時実行数の上限」）。sakutto の「最初に待たれる文を満員の組と一緒に読ませない」と同じ考え方（docs/10 N9）。
 */
// 時間で区切らず、出来事で残りを送る。以前は 400ms の保険で区切っており、原文の読み込みが遅い PC（検証環境Bの内蔵GPUで約0.6秒）では
// 最初の行より先に残り7バッチ（約550トークン）の読み込み 2.2秒が始まり、最初の行を止めていた（2026-11-10、docs/10「最初の行（N9）」）。
// 1行目が長くて行が届かない場合も、返事が来れば必ず送り始めるので止まらない。
/** 先に1本だけ送ったバッチの番号。0 なら制限なし。 */
let solo = 0;
/**
 * 訳す流れの途中か。訳すものが無くなったら false に戻る。先に1本だけ送るのは、流れの始め（訳し始め・スクロールで新しい段落が出たとき）だけにする。
 * 見出しを訳し終えて送信中が一時的に0本になったときに先送りすると、1行の長い段落（約790字の注記など）が訳し終わるまで
 * 残りが送られず、約5秒止まっていた（2026-11-12、GitHub の Copilot の Models のページ）。
 */
let flowing = false;

/** 先に送ったバッチの最初の行が届いた・返事が来たら、残りを送り始める。 */
function releaseSolo(id) {
  if (!solo || (id !== undefined && id !== solo)) return;
  solo = 0;
  pump();
}

/** 訳を待つ段落を、見えている順に workers 本まで同時に送る。1本が返るたびに次を送る。 */
export function pump() {
  while (!solo && state.chunks.size < workers && !state.halted && state.mode !== 'orig' && state.pending.size > 0) {
    // 画面内の見出し・第1段落を訳している間は、それより後ろの段だけのバッチを足さない（見出しの訳を先に出しきる）。
    if (frontBusy() && ![...state.pending].some(isFront)) break;
    const idle = state.chunks.size === 0;
    const chunk = nextChunk();
    if (chunk.length === 0) break;
    const run = runChunk(chunk, state.generation);
    const id = state.seq; // runChunk は最初の await の前に番号を振る
    run.finally(() => {
      releaseSolo(id);
      pump();
      finishIfDone();
    });
    if (idle && !flowing && workers > 1 && state.pending.size > 0) {
      solo = id;
    }
    flowing = true;
  }
  if (state.pending.size === 0 && state.chunks.size === 0) flowing = false;
  report();
}

/** 画面内の見出し・第1段落を含むバッチを訳しているか。 */
function frontBusy() {
  for (const c of state.chunks.values()) if (c.generation === state.generation && !c.cancelling && c.paras.some(isFront)) return true;
  return false;
}

async function runChunk(chunk, generation) {
  const t = performance.now();
  const id = ++state.seq;
  const texts = chunk.map((p) => p.text);
  if (state.chunks.size === 0) state.busySince = t; // 速さは、送ったバッチがある間の時間で割る（スクロール待ちの時間を入れない）
  state.chunks.set(id, { paras: chunk, texts, t, generation });
  setWorking(chunk, true); // 訳している途中の段落に装飾を付ける
  // screen は画面内の段落の数。画面内の訳し終わりがどのバッチで決まったかを、ログから追えるようにする（tools/page-replay.mjs）。
  const screen = chunk.filter((p) => state.firstScreen.has(p)).length;
  trace('送信', { id, lines: texts.length, chars: texts.join('').length, screen, texts: texts.map((s) => short(s)), inflight: state.chunks.size, pending: state.pending.size });
  let response;
  try {
    response = await send({ type: MSG.TRANSLATE_BATCH, texts, id });
  } catch (e) {
    response = { ok: false, error: e.message };
  } finally {
    state.chunks.delete(id);
    if (state.chunks.size === 0 && state.busySince) {
      state.busyMs += performance.now() - state.busySince;
      state.busySince = 0;
    }
    setWorking(chunk, false);
  }
  const ms = Math.round(performance.now() - t);
  debug(`受信 ${chunk.length}行（${ms}ms）${response?.ok ? '' : ' 失敗：' + (response?.error ?? '返事なし')}`);
  trace(response?.cancelled ? '取り消し済み' : response?.ok ? '受信' : '失敗', { id, ms, error: response?.error, requests: response?.stats?.requests });
  const waiters = takeWaiting(texts, generation);
  setWorking(waiters, false);
  if (generation !== state.generation) return; // 途中で訳し直し・翻訳の終了があった（待っていた段落も捨てる。訳し直しは全段落を入れ直す）
  if (response?.cancelled) {
    // 古くなって取り消した（新しい文字は書き換えの監視が送り直す）。文字が変わらずページに残っている段落と、
    // 同じ文を待っていた段落は列に戻す（取り消しが古くなっていない段落にも及んだとき、訳されずに残さない）。
    chunk.forEach((para, i) => {
      if (connected(para) && para.text === texts[i] && para.translation == null) state.pending.add(para);
    });
    for (const para of waiters) if (connected(para)) state.pending.add(para);
    return;
  }
  clearNotice();
  if (!response?.ok) {
    // 失敗が続くときに送り続けないよう、利用者が次に操作するまで止める。
    for (const para of [...chunk, ...waiters]) state.pending.add(para);
    state.halted = true;
    showBar();
    barMessage(response?.error ?? '翻訳に失敗しました。', true);
    return;
  }
  if (barHasError()) barMessage(null);
  state.model = response.model;
  state.requests += response.stats.requests;
  state.tokens += response.stats.tokens ?? 0;
  state.loadMs = Math.max(state.loadMs, response.stats.loadMs ?? 0);
  chunk.forEach((para, i) => {
    state.cache.set(para.text, response.results[i]);
    if (para.translation !== response.results[i]) apply(para, response.results[i]); // 逐次表示で同じ訳を出していれば書き直さない
  });
  // 同じ文の訳を待っていた段落にも書き込む。待つ間に文字が変わった段落は、キャッシュに無ければ列へ戻す。
  for (const para of waiters) {
    if (!connected(para)) continue;
    const v = state.cache.get(para.text);
    if (v === undefined) state.pending.add(para);
    else if (para.translation !== v) apply(para, v);
  }
  if (state.firstScreen.size === 0 && state.firstScreenDone === false) {
    state.firstScreenDone = seconds();
    log(`画面内の訳し終わり ${state.firstScreenDone}秒（${state.model}）`);
  }
}

/**
 * 送ったバッチのうち、段落がすべてページから消えたか、文字が変わったものを取り消す。
 * 取り消すとOffscreen Document側で生成を止め、枠を空ける。
 */
export function cancelStale() {
  for (const [id, c] of state.chunks) {
    if (c.cancelling) continue;
    if (!c.paras.every((p, i) => !connected(p) || p.text !== c.texts[i])) continue;
    c.cancelling = true;
    trace('取り消し', { id, age: Math.round(performance.now() - c.t) });
    notify({ type: MSG.CANCEL, id });
  }
}

/**
 * バッチのうち訳し終わった行を、返事を待たずに先に出す（Offscreen Documentが生成の途中で送ってくる）。
 * 最後の返事で、行がずれた・訳されていない行は訳し直した訳に置き換わる。キャッシュには最後の返事だけを入れる。
 */
export function showPartial(id, lines) {
  releaseSolo(id);
  const c = state.chunks.get(id);
  if (!c || c.cancelling) return;
  for (const { i, text } of lines) {
    const para = c.paras[i];
    if (!para || !text.trim() || para.translation === text || para.text !== c.texts[i]) continue;
    apply(para, text);
    setWorking([para], false);
    // 同じ文を待っている段落にも先に出す（最後の返事で確定した訳に置き換わる）。
    for (const w of waiting.get(`${c.generation}\n${c.texts[i]}`) ?? []) {
      if (w.text !== c.texts[i] || w.translation === text) continue;
      apply(w, text);
      setWorking([w], false);
    }
  }
  updateBar();
}

/** 訳を待つ段落も送ったバッチも無くなったら、「訳し終えました」を出す（最初のページ全体だけ）。 */
function finishIfDone() {
  if (state.pending.size > 0 || state.chunks.size > 0 || !state.t0) return;
  log(`全体の訳し終わり ${seconds()}秒（${state.model}、${state.translated}段落、問い合わせ${state.requests}回、${tokensPerSecond()} tok/s）`);
  if (!state.notified) {
    state.notified = true;
    const first = state.firstScreenDone ? `画面内 ${state.firstScreenDone}秒・` : '';
    const tps = tokensPerSecond();
    setBarDone(`訳し終えました：${state.translated}段落、${first}全体 ${seconds()}秒${tps ? `・${tps} tok/s` : ''}`);
  }
  state.t0 = 0;
  updateBar();
}

/** 計測をやり直す。いま画面に見えている段落を「画面内」として覚える。 */
export function resetMeasure(paras) {
  state.t0 = performance.now();
  state.translated = 0;
  state.requests = 0;
  state.tokens = 0;
  state.loadMs = 0;
  state.busyMs = 0;
  state.busySince = state.chunks.size ? performance.now() : 0;
  state.notified = false;
  state.firstScreenDone = false;
  state.firstScreen = new Set(paras.filter((p) => !p.translation && onScreen(p)));
}

/** バーとボタンのバッジを今の状態に合わせる。 */
export function report() {
  updateBar();
  notify({ type: MSG.PROGRESS, pending: state.pending.size });
}
