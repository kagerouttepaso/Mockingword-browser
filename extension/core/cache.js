// 訳文のキャッシュ。同じ文を何度も訳さないために、メモリー（速い）と IndexedDB（Service Workerが止まっても、ブラウザーを閉じても残る）の2段で持つ。
// Service Workerは数十秒使わないと止まり、メモリーのキャッシュはそのたびに消えるので、IndexedDB に残す。
// 鍵は「モデル|原文の言語|訳文の言語|文体|原文」。IndexedDB は最大 DB_LIMIT 件で、超えたら古く使ったものから消す。設計は docs/03_翻訳コア.md「訳文のキャッシュ」。

const MEMORY_LIMIT = 3000;
const DB_LIMIT = 20000;
const memory = new Map();

/** キャッシュの鍵。 */
export function cacheKey(text, options) {
  return `${options.model}|${options.source ?? 'auto'}|${options.target ?? 'ja'}|${options.form}|${text}`;
}

function rememberMemory(key, value) {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

// ---------------- IndexedDB ----------------

let dbPromise = null;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('plamo-translate-cache', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tr').createIndex('t', 't');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    console.warn('[Mockingword] 訳文のキャッシュ（IndexedDB）を開けません', e);
    dbPromise = null;
    return null;
  });
  return dbPromise;
}

async function dbGetMany(keys) {
  const db = await openDb();
  if (!db || keys.length === 0) return keys.map(() => undefined);
  return new Promise((resolve) => {
    const out = new Array(keys.length);
    const tx = db.transaction('tr', 'readonly');
    const store = tx.objectStore('tr');
    keys.forEach((k, i) => {
      const q = store.get(k);
      q.onsuccess = () => (out[i] = q.result?.v);
    });
    tx.oncomplete = () => resolve(out);
    tx.onerror = tx.onabort = () => resolve(out);
  });
}

/** 書き込みは0.3秒ためてまとめて行う。 */
const toWrite = new Map();
let writeTimer = 0;
let writesSincePrune = 0;

async function flushWrites() {
  const db = await openDb();
  if (!db || toWrite.size === 0) return;
  const entries = [...toWrite];
  toWrite.clear();
  const tx = db.transaction('tr', 'readwrite');
  const store = tx.objectStore('tr');
  const now = Date.now();
  for (const [k, v] of entries) store.put({ v, t: now }, k);
  writesSincePrune += entries.length;
  if (writesSincePrune > 500) {
    writesSincePrune = 0;
    tx.oncomplete = () => prune(db);
  }
}

/** 上限を超えたら、古く使ったものから1割多めに消す。 */
function prune(db) {
  const tx = db.transaction('tr', 'readwrite');
  const store = tx.objectStore('tr');
  const count = store.count();
  count.onsuccess = () => {
    let extra = count.result - Math.floor(DB_LIMIT * 0.9);
    if (extra <= 0) return;
    store.index('t').openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || extra-- <= 0) return;
      cursor.delete();
      cursor.continue();
    };
  };
}

// ---------------- 外から使う関数 ----------------

/** 訳をキャッシュに入れる。 */
export function remember(key, value) {
  rememberMemory(key, value);
  toWrite.set(key, value);
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrites, 300);
}

/** 鍵の並びの訳を、メモリー→IndexedDB の順に引く。無いものは undefined。 */
export async function lookup(keys) {
  const out = keys.map((k) => memory.get(k));
  const missing = out.map((v, i) => (v === undefined ? i : -1)).filter((i) => i >= 0);
  if (missing.length) {
    const found = await dbGetMany(missing.map((i) => keys[i]));
    missing.forEach((i, k) => {
      if (found[k] !== undefined) {
        out[i] = found[k];
        rememberMemory(keys[i], found[k]);
      }
    });
  }
  return out;
}

/**
 * キャッシュの件数と大きさ（設定画面に出す）。大きさは鍵と訳文の字数から見積もる（JavaScript の文字列は1字2バイト）。
 * 合わせて、拡張機能がブラウザーの中で使っている量の合計（モデルを含む）を navigator.storage.estimate で返す。
 */
export async function stats() {
  await flushWrites();
  const db = await openDb();
  let count = 0;
  let bytes = 0;
  if (db) {
    await new Promise((resolve) => {
      const tx = db.transaction('tr', 'readonly');
      tx.objectStore('tr').openCursor().onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        count++;
        bytes += (String(cursor.key).length + String(cursor.value?.v ?? '').length) * 2 + 16;
        cursor.continue();
      };
      tx.oncomplete = tx.onerror = resolve;
    });
  }
  const estimate = await navigator.storage?.estimate?.().catch(() => null);
  return { count, bytes, limit: DB_LIMIT, usage: estimate?.usage ?? null };
}

/** キャッシュをすべて消す（設定画面の「キャッシュを消す」）。 */
export async function clear() {
  memory.clear();
  toWrite.clear();
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction('tr', 'readwrite');
    tx.objectStore('tr').clear();
    tx.oncomplete = tx.onerror = resolve;
  });
}
