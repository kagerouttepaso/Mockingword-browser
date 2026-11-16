// 設定画面。選んだ値は chrome.storage.sync（同期する設定）か chrome.storage.local（PCごとの調整）に置き、
// Service Worker（background/config.js）が翻訳のたびに読む。
import { DEFAULTS, LOCAL_DEFAULTS, PARALLEL_CHOICES, UBATCH_CHOICES, fillLanguages, describeStatus, normalizeLocal } from '../shared/settings.js';
import { MSG } from '../shared/messages.js';

const cores = navigator.hardwareConcurrency || 1;
document.getElementById('cores').textContent = cores;
const threads = document.getElementById('threads');
threads.append(new Option(`自動（${Math.max(1, Math.floor(cores / 2))}）`, '0'));
for (let n = 1; n <= cores; n++) threads.append(new Option(String(n), String(n)));
for (const n of PARALLEL_CHOICES) document.getElementById('parallel').append(new Option(`${n}件${n === LOCAL_DEFAULTS.parallel ? '（既定）' : ''}`, String(n)));
for (const n of UBATCH_CHOICES) document.getElementById('ubatch').append(new Option(`${n}${n === LOCAL_DEFAULTS.ubatch ? '（既定）' : ''}`, String(n)));
fillLanguages(document.getElementById('source'));

const NUMBERS = ['threads', 'idleMinutes', 'parallel', 'ubatch'];

/** 画面の入力に保存済みの値を入れる。 */
function show(values) {
  for (const [name, value] of Object.entries(values)) {
    const radio = document.querySelector(`input[name="${name}"][value="${value}"]`);
    if (radio) radio.checked = true;
    const box = document.querySelector(`input[type="checkbox"][name="${name}"]`);
    if (box) box.checked = !!value;
    const select = document.querySelector(`select[name="${name}"]`);
    if (select) select.value = String(value);
  }
}
show(await chrome.storage.sync.get(DEFAULTS));
show(normalizeLocal(await chrome.storage.local.get(LOCAL_DEFAULTS)));
document.addEventListener('change', (e) => {
  const { name, value } = e.target;
  if (!name) return;
  const v = e.target.type === 'checkbox' ? e.target.checked : NUMBERS.includes(name) ? Number(value) : value;
  (name in LOCAL_DEFAULTS ? chrome.storage.local : chrome.storage.sync).set({ [name]: v });
  setTimeout(render, 300); // PCごとの調整を変えると解放されるので、状態を出し直す
});
// 「このPCに合わせる」で選んだ値が保存されたら、画面の選択にも出す。
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  const changed = Object.fromEntries(Object.keys(LOCAL_DEFAULTS).filter((k) => c[k]).map((k) => [k, c[k].newValue]));
  if (Object.keys(changed).length) show(changed);
});

// ---- このPCに合わせる ----
const tuneBtn = document.getElementById('tune');
const stopBtn = document.getElementById('tunestop');
const speedBtn = document.getElementById('speed');
const tuneState = document.getElementById('tunestate');
const table = document.getElementById('tunerows');

/** 測った結果を表にする。best の行を太字にする。 */
function showRows(rows, best) {
  table.hidden = !rows?.length;
  const body = table.querySelector('tbody');
  body.replaceChildren();
  for (const r of rows ?? []) {
    const tr = body.insertRow();
    const isBest = best && !r.error && r.parallel === best.parallel && r.ubatch === best.ubatch && (best.threads == null || r.threads === best.threads);
    if (isBest) tr.className = 'best';
    tr.insertCell().textContent = r.label;
    tr.insertCell().textContent = r.error ? '読み込めず' : `${(r.ms / 1000).toFixed(2)}秒${r.spread != null ? `（±${Math.round((r.spread * 100) / 2)}%）` : ''}`;
    tr.insertCell().textContent = r.error || r.firstMs == null ? '' : `${(r.firstMs / 1000).toFixed(2)}秒`;
    tr.insertCell().textContent = r.error ? r.error.slice(0, 60) : `${r.tps} トークン/秒`;
    tr.insertCell().textContent = isBest ? '← 選んだ設定' : '';
  }
}

function busy(on) {
  tuneBtn.disabled = speedBtn.disabled = on;
  stopBtn.hidden = !on;
}

chrome.runtime.onMessage.addListener((m) => {
  if (m?.type !== MSG.TUNE_PROGRESS) return;
  if (m.text) tuneState.textContent = m.text;
  if (m.rows) showRows(m.rows);
});

tuneBtn.onclick = async () => {
  busy(true);
  const r = await chrome.runtime.sendMessage({ type: MSG.TUNE }).catch((e) => ({ ok: false, error: e.message }));
  busy(false);
  if (!r?.ok) {
    tuneState.textContent = `調整できませんでした：${r?.error ?? '返事がありません'}`;
    return;
  }
  showTuneResult(r.result);
  render();
};
stopBtn.onclick = () => {
  stopBtn.disabled = true;
  tuneState.textContent = '今の設定を測り終えたところでやめます…';
  chrome.runtime.sendMessage({ type: MSG.TUNE_STOP }).finally(() => (stopBtn.disabled = false));
};
speedBtn.onclick = async () => {
  busy(true);
  const r = await chrome.runtime.sendMessage({ type: MSG.SPEED_TEST }).catch((e) => ({ ok: false, error: e.message }));
  busy(false);
  if (!r?.ok) {
    tuneState.textContent = `測れませんでした：${r?.error ?? '返事がありません'}`;
    return;
  }
  const row = r.row;
  tuneState.textContent = `今の設定（${row.device === 'cpu' ? 'CPU' : 'GPU'}・${row.label}）：試験用の文章24件（キャッシュなし）を ${(row.ms / 1000).toFixed(2)}秒（3回の中央値）、最初の1件は ${(row.firstMs / 1000).toFixed(2)}秒、${row.tps} トークン/秒（モデルの読み込みと、最初の準備の1回は含めない）`;
  render();
};

/** 前回の「このPCに合わせる」の結果を出す。 */
function showTuneResult(t) {
  if (!t) return;
  const when = new Date(t.at).toLocaleString('ja-JP');
  const c = t.chosen;
  const how = t.device === 'cpu' ? `CPU ${c.threads}スレッド・同時${c.parallel}件` : `同時${c.parallel}件・ubatch ${c.ubatch}`;
  tuneState.textContent = `${when} に ${t.model}・${t.device === 'cpu' ? 'CPU' : `GPU（${t.adapter ?? '名前不明'}）`} で合わせ、${how} を選びました${t.stopped ? '（途中でやめたので、そこまでの結果から選択）' : ''}。`;
  showRows(t.rows, c);
}
showTuneResult((await chrome.storage.local.get('tuneResult')).tuneResult);

const unload = document.getElementById('unload');
unload.onclick = async () => {
  unload.disabled = true;
  await chrome.runtime.sendMessage({ type: MSG.UNLOAD });
  render();
};

/** モデルを読み込む前に出す、この画面から見える WebGPU の GPU の名前（Offscreen Documentも同じものを使う）。 */
async function gpuName() {
  try {
    const a = await navigator.gpu?.requestAdapter();
    if (!a) return 'WebGPU を使えません（CPU で動きます）';
    const i = a.info ?? {};
    return ([i.description, i.vendor, i.architecture].filter(Boolean).join(' / ') || 'WebGPU') + '（訳すときに確かめます）';
  } catch {
    return 'WebGPU を使えません（CPU で動きます）';
  }
}

async function render() {
  const s = await chrome.runtime.sendMessage({ type: MSG.STATUS });
  document.querySelector('#status span').textContent = describeStatus(s);
  unload.disabled = !s?.loaded && !s?.loading;
  if (s?.loaded) document.getElementById('adapter').textContent = s.device === 'gpu' ? s.adapter ?? '名前を取れませんでした' : '使っていません（CPU で動いています）';
  else if (document.getElementById('adapter').textContent === '確認中…') document.getElementById('adapter').textContent = await gpuName();
}
render();
setInterval(render, 30_000);

// ---- 訳文のキャッシュの件数と大きさ ----
const mb = (bytes) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`);
async function renderCache() {
  const s = await chrome.runtime.sendMessage({ type: MSG.CACHE_STATS });
  if (!s?.ok) return;
  const usage = s.usage != null ? `。拡張機能がブラウザーの中で使っている量の合計は約 ${mb(s.usage)}（翻訳モデルを含む）` : '';
  document.getElementById('cachestats').textContent = `翻訳のキャッシュ：${s.count.toLocaleString()} 件（上限 ${s.limit.toLocaleString()} 件）・約 ${mb(s.bytes)}${usage}`;
}
document.getElementById('cacheclear').onclick = async (e) => {
  e.target.disabled = true;
  await chrome.runtime.sendMessage({ type: MSG.CACHE_CLEAR });
  await renderCache();
  e.target.disabled = false;
};
renderCache();

// ---- 調査用のログ ----
async function renderLogs() {
  const r = await chrome.runtime.sendMessage({ type: MSG.LOGS_GET });
  document.getElementById('logcount').textContent = `記録 ${r?.logs?.length ?? 0} 件`;
  return r?.logs ?? [];
}
document.getElementById('logsave').onclick = async () => {
  const logs = await renderLogs();
  const blob = new Blob([JSON.stringify({ saved: new Date().toISOString(), version: chrome.runtime.getManifest().version, settings: { ...(await chrome.storage.sync.get(DEFAULTS)), ...(await chrome.storage.local.get(LOCAL_DEFAULTS)) }, logs }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `mockingword-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
};
document.getElementById('logclear').onclick = async () => {
  await chrome.runtime.sendMessage({ type: MSG.LOGS_CLEAR });
  renderLogs();
};
renderLogs();
setInterval(renderLogs, 3000);

chrome.storage.onChanged.addListener((c, area) => { if (area === 'sync' && c.theme) show({theme:c.theme.newValue ?? 'system'}); });
