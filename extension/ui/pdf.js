// PDF翻訳のページ。?src=<PDFのURL> の PDF、または選んだ・ドラッグした PDF を、レイアウト・リンク・しおりを残したまま訳す。
// 表示は pdf.js のビューア（拡大・リンク・文字の選択・検索）。訳したPDFは Worker（pdf/worker.js）が PDFium で1つ書き、
// ページの段落がそろうたびにそのページを書いて版を送る。画面はその版のページに差し替える（ui/pdf-pages.js）ので、
// 見えている訳文と保存するPDFは同じもの。訳している段落の原文は半透明にする（ui/pdf-overlay.js）。流れは docs/12_PDFの翻訳.md。
import { MSG } from '../shared/messages.js';
import { describeStatus, LOCAL_DEFAULTS, normalizeLocal } from '../shared/settings.js';
import { createPdfBatchRequests } from './pdf-batches.js';
import { createOutline } from './pdf-outline.js';
import { createOverlay } from './pdf-overlay.js';
import { createPages } from './pdf-pages.js';
import { createStore } from './pdf-state.js';
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

// pdf.js のビューアの部品は globalThis.pdfjsLib を読むので、先に置いてから読み込む。
globalThis.pdfjsLib = pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const { EventBus, LinkTarget, PDFHistory, PDFLinkService, PDFViewer } = await import('../vendor/pdfjs/pdf_viewer.mjs');

const $ = (id) => document.getElementById(id);
const status = $('status');
const progress = $('progress');
const container = $('viewerContainer');
let fileName = 'document.pdf';
let running = false;

const STAGES = { read: 'PDFを読んでいます', font: '日本語フォントを用意しています', translate: '訳しています', save: '保存するPDFを仕上げています' };

function setProgress(done, total) {
  progress.hidden = total == null;
  if (total == null) return;
  progress.max = total || 1;
  if (done == null) progress.removeAttribute('value');
  else progress.value = done;
}

/** モデルを読み込んでいる間は、訳し始めるまでの様子を出す（初回はモデルの取得に時間がかかる）。 */
let waitingModel = null;
function watchModel(on) {
  clearInterval(waitingModel);
  waitingModel = null;
  if (!on) return;
  waitingModel = setInterval(async () => {
    const s = await chrome.runtime.sendMessage({ type: MSG.STATUS }).catch(() => null);
    if (s && !s.loaded) status.textContent = `${STAGES.translate}（${describeStatus(s)}）`;
  }, 1000);
}

const batches = createPdfBatchRequests((message) => chrome.runtime.sendMessage(message));

// ---------------- pdf.js のビューア ----------------

const eventBus = new EventBus();
// PDF の外へのリンク（Web ページ）は新しいタブで開く。同じタブで開くと、戻ったときに PDF を開くところからやり直しになる（作者の報告）
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow' });
/** 画面の文言は使わないので、pdf.js の多言語化は何もしない形で渡す（言語ファイルを取得しにいかない）。 */
const l10n = {
  getLanguage: () => 'ja', getDirection: () => 'ltr',
  get: async (ids, args, fallback) => fallback ?? '', translate: async () => {}, translateOnce: async () => {},
  pause() {}, resume() {}, destroy: async () => {},
};
const viewer = new PDFViewer({ container, eventBus, linkService, l10n, textLayerMode: 1, annotationMode: pdfjsLib.AnnotationMode.ENABLE });
linkService.setViewer(viewer);
// 見出し・文書の中のリンクで移るとき、移る前の位置をブラウザーの履歴に積む（「戻る」「進む」、Alt+←・→で行き来できる）
const pdfHistory = new PDFHistory({ linkService, eventBus });
linkService.setHistory(pdfHistory);
const backButton = $('back');
const forwardButton = $('forward');
/** 戻れる・進めるかをボタンに映す（pdf.js の履歴の番号 uid と、積んだ最大の番号 _maxUid で決まる）。 */
function updateNavigation() {
  const uid = history.state?.uid;
  backButton.disabled = !(pdfHistory._initialized && uid > 0);
  forwardButton.disabled = !(pdfHistory._initialized && uid < pdfHistory._maxUid);
}
backButton.onclick = () => pdfHistory.back();
forwardButton.onclick = () => pdfHistory.forward();
addEventListener('popstate', () => setTimeout(updateNavigation));
eventBus.on('updateviewarea', updateNavigation);

// 幅・高さに合わせる表示は、表示する欄の大きさが変わったら（見出しの欄の開閉・ウィンドウの大きさ）合わせ直す
new ResizeObserver(() => {
  if (viewer.pdfDocument && ['page-width', 'page-height'].includes(viewer.currentScaleValue)) viewer.currentScaleValue = viewer.currentScaleValue;
}).observe(container);

// 表示の大きさ（幅・高さに合わせる・100%・拡大縮小）とページの並べ方（1ページずつ・見開き）。選んだものはこの画面に覚える。
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const recall = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const scaleSelect = $('scale');
const spreadSelect = $('spread');
function setScale(value) {
  viewer.currentScaleValue = value;
  remember('pdfScale', value);
}
eventBus.on('pagesinit', () => {
  viewer.spreadMode = Number(recall('pdfSpread', '0'));
  setScale(recall('pdfScale', 'page-width'));
});
eventBus.on('scalechanging', ({ presetValue, scale }) => {
  const preset = [...scaleSelect.options].find((o) => o.value === presetValue && o.value !== 'custom');
  const custom = scaleSelect.querySelector('[value="custom"]');
  custom.hidden = !!preset;
  custom.textContent = `${Math.round(scale * 100)}%`;
  scaleSelect.value = preset ? preset.value : 'custom';
});
scaleSelect.onchange = () => { if (scaleSelect.value !== 'custom') setScale(scaleSelect.value); };
const showOutline = (open) => {
  document.body.classList.toggle('outline-open', open);
  $('toggle-outline').setAttribute('aria-pressed', String(open));
  remember('pdfOutline', open ? '1' : '0');
};
showOutline(recall('pdfOutline', '1') === '1');
$('toggle-outline').onclick = () => showOutline(!document.body.classList.contains('outline-open'));
spreadSelect.value = recall('pdfSpread', '0');
spreadSelect.onchange = () => {
  viewer.spreadMode = Number(spreadSelect.value);
  remember('pdfSpread', spreadSelect.value);
};

// ---------------- 状態と画面 ----------------
// 状態の正本は store（ui/pdf-state.js）。訳す処理やボタンは store の関数で状態を変え、画面は store の知らせで描く。

const store = createStore();
createOverlay(store, viewer);
createPages(store, viewer, eventBus);
createOutline(store, $('outline-tree'), (node) => {
  if (node.dest) linkService.goToDestination(node.dest);
  else if (node.url) window.open(node.url, '_blank', 'noopener');
});
store.subscribe((change, state) => {
  if (change.type !== 'mode') return;
  const original = state.mode === 'original';
  document.body.classList.toggle('mw-original', original);
  $('show-trans').classList.toggle('primary', !original);
  $('show-orig').classList.toggle('primary', original);
});

// ---------------- 訳す ----------------

/** 開いた PDF（翻訳を始めるまでは原文を表示するだけ）。 */
let current = null;
/** 訳す Worker（pdf/worker.js）。訳し始めるときに作り、PDF を開き直したら止める。中止しても残し、再開すると続きから訳す。 */
let worker = null;
let started = 0;
let paused = false; // 中止して、再開を待っている
let stopping = false;

/** 訳している Worker を止めて捨てる（別の PDF を開くとき）。 */
function dropWorker() {
  batches.cancel();
  worker?.terminate();
  worker = null;
  paused = false;
  stopping = false;
  if (running) store.abort();
  running = false;
  watchModel(false);
  setProgress(null, null);
  $('stop').hidden = true;
}

/** PDF を pdf.js のビューアで開く。訳すのは「翻訳を開始」を押してから（作者の希望。開いただけでモデルやフォントを取得しない）。 */
async function load(bytes, name) {
  // 訳している途中でも、新しい PDF を開いたら今の翻訳はやめる（訳したPDFは保存していなければ捨てる）
  dropWorker();
  fileName = name;
  document.title = `${name} - Mockingword PDF翻訳`;
  $('pick').hidden = true;
  for (const id of ['save', 'views', 'start', 'stop']) $(id).hidden = true;
  $('start').textContent = '翻訳を開始';
  container.hidden = false;
  current = null;
  store.setMode('translated');
  status.textContent = STAGES.read;
  status.title = '';
  try {
    // pdf.js へはバイト列の写しを渡す（pdf.js は渡したものを Worker へ移して使えなくする）
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    const pagesInit = new Promise((resolve) => eventBus.on('pagesinit', resolve, { once: true }));
    viewer.setDocument(pdf);
    linkService.setDocument(pdf);
    const views = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1).then((page) => page.view)));
    const outline = await pdf.getOutline().catch(() => null);
    await pagesInit; // ページの要素がそろってから半透明の表示の層を置けるようにする
    pdfHistory.initialize({ fingerprint: pdf.fingerprints[0], resetHistory: true });
    // 開いた位置を最初の履歴にする。記録が無いと pdf.js は最初の移動で履歴を積まずに置き換え、戻れなくなる
    pdfHistory.pushPage(1);
    store.open(pdf, views, outline);
    updateNavigation();
    $('zoom').hidden = false;
    current = { bytes, name };
    $('start').hidden = false;
    status.textContent = '「翻訳を開始」を押すと、見ているページから訳します';
  } catch (e) {
    status.textContent = `PDFを開けませんでした：${e.message}`;
    $('pick').hidden = false;
    console.error(e);
  }
}

/** 版（訳したPDFのバイト列）を pdf.js で開いて状態へ渡す。届いた順に処理する（後の版が先に開き終わっても順を守る）。 */
let versionChain = Promise.resolve();
function receiveVersion(bytes, pages) {
  const w = worker;
  versionChain = versionChain.then(async () => {
    const doc = await pdfjsLib.getDocument({ data: bytes, isEvalSupported: false }).promise;
    if (w !== worker) return doc.destroy(); // 別の PDF を開き直した
    store.addVersion(doc, pages);
    $('save').hidden = false;
  }).catch((e) => console.error(e));
}

function finish(message, title = '') {
  watchModel(false);
  setProgress(null, null);
  status.textContent = message;
  status.title = title;
  running = false;
  $('stop').hidden = true;
}

function fail(message) {
  batches.cancel();
  store.abort();
  finish(`訳せませんでした：${message}`);
  $('start').hidden = false;
}

/** 保存した PDF をファイルにする。 */
function saveFile(r) {
  const url = URL.createObjectURL(new Blob([r.bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/\.pdf$/i, '') + '_ja.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  $('save').disabled = false;
  if (!running) status.textContent = '訳したPDFを保存しました' + (r.encrypted ? '（暗号化されたPDFのため、しおりは原文のままです）' : '');
  status.title = `しおり ${r.outline}、${(r.inBytes / 1e6).toFixed(2)}MB → ${(r.outBytes / 1e6).toFixed(2)}MB`;
}

/** Worker からの知らせ（種類は pdf/worker.js の冒頭）。 */
function onWorkerMessage({ currentTarget: w, data: m }) {
  if (w !== worker) return;
  if (m.type === 'opened') startWorker(w);
  else if (m.type === 'translate') {
    if (!running || stopping) return;
    batches.translate(m.texts).then(
      (results) => { if (w === worker && !stopping) w.postMessage({ type: 'translated', id: m.id, results }); },
      (e) => { if (w === worker && !stopping) w.postMessage({ type: 'translated', id: m.id, error: e.message }); },
    );
  } else if (m.type === 'stage') {
    if (stopping) return;
    if (m.stage === 'translate' && running) $('stop').hidden = false;
    const percent = m.stage === 'translate' && m.total ? `（${Math.floor((m.done / m.total) * 100)}%）` : '';
    status.textContent = STAGES[m.stage] + percent;
    setProgress(m.done, m.total ?? null);
    watchModel(m.stage === 'translate' && !m.done);
  } else if (m.type === 'status') store.setMarks(m.list, m.status);
  else if (m.type === 'version') receiveVersion(m.bytes, m.pages);
  else if (m.type === 'titles') store.setTitles(m.entries);
  else if (m.type === 'done') {
    const s = m.stats;
    const title = `原文と同じため残した段落 ${s.same}、背景で覆った段落 ${s.masked}、縮めた段落 ${s.shrunk}、移したリンク ${s.links}、時間（ミリ秒） ${JSON.stringify(s.ms)}`;
    versionChain.then(() => {
      if (w !== worker) return;
      if (!s.stopped) return finish(`訳しました（${s.translated}段落、${Math.round((performance.now() - started) / 1000)}秒）`, title);
      store.abort();
      paused = true;
      finish('翻訳を中止しました。訳し終えたページは訳文のままです。「翻訳を再開」で続きを訳します', title);
      $('start').textContent = '翻訳を再開';
      $('start').hidden = false;
    });
  } else if (m.type === 'saved') saveFile(m.result);
  else if (m.type === 'error') {
    if (m.during !== 'save') return fail(m.message);
    $('save').disabled = false;
    status.textContent = `保存できませんでした：${m.message}`;
  }
}

async function startWorker(w) {
  const local = await chrome.storage.local.get(LOCAL_DEFAULTS).catch(() => LOCAL_DEFAULTS);
  if (w === worker && running && !stopping) w.postMessage({ type: 'start', parallel: normalizeLocal(local).parallel });
}

/** 開いている PDF を訳す。ページの段落がそろうたびに、そのページを訳したPDFのページに差し替える。 */
function start() {
  if (running || !current) return;
  running = true;
  stopping = false;
  $('start').hidden = true;
  $('stop').disabled = false; // 「翻訳を中止」は訳し始めてから出す（Worker が PDF を読んでいる間は止める先が無い）
  $('views').hidden = false;
  store.setMode('translated');
  if (paused && worker) {
    // 中止した翻訳を続きから訳す（訳したページ・訳したPDFはそのまま）
    paused = false;
    status.textContent = STAGES.translate;
    worker.postMessage({ type: 'focus', page: Math.max(0, viewer.currentPageNumber - 1) });
    startWorker(worker);
    return;
  }
  started = performance.now();
  store.begin();
  status.textContent = STAGES.read;
  worker?.terminate();
  worker = new Worker(new URL('../pdf/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMessage;
  worker.onerror = (e) => fail(e.message);
  worker.postMessage({ type: 'focus', page: Math.max(0, viewer.currentPageNumber - 1) });
  const bytes = current.bytes.slice();
  worker.postMessage({ type: 'open', bytes }, [bytes.buffer]);
}
eventBus.on('pagechanging', ({ pageNumber }) => worker?.postMessage({ type: 'focus', page: pageNumber - 1 }));

// ---------------- PDF を受け取る ----------------

async function download(src) {
  const response = await fetch(src, { credentials: 'include' });
  if (!response.ok) throw new Error(`取得できませんでした（${response.status}）`);
  return response.arrayBuffer();
}

/** file:// は fetch で読めないので XMLHttpRequest で読む（拡張機能に「ファイルの URL へのアクセス」が許可されているときだけ読める）。 */
function readFileUrl(src) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', src);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => (xhr.response?.byteLength ? resolve(xhr.response) : reject(new Error('読み込めませんでした')));
    xhr.onerror = () => reject(new Error('読み込めませんでした'));
    xhr.send();
  });
}

async function openUrl(src) {
  status.textContent = 'PDFを取得しています';
  try {
    const bytes = new Uint8Array(src.startsWith('file:') ? await readFileUrl(src) : await download(src));
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') throw new Error('PDFではありません');
    const name = decodeURIComponent(new URL(src).pathname.split('/').pop() || 'document.pdf');
    await load(bytes, name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`);
  } catch (e) {
    status.textContent = src.startsWith('file:')
      ? 'このファイルを読み込めませんでした。PDFをここへドラッグするか「PDFを開く」で選んでください（拡張機能の詳細で「ファイルのURLへのアクセスを許可」をオンにすると、開いたPDFからそのまま訳せます）'
      : `PDFを開けませんでした：${e.message}`;
    $('pick').hidden = false;
  }
}

async function openFile(file) {
  if (!file) return;
  await load(new Uint8Array(await file.arrayBuffer()), file.name);
}

$('start').onclick = () => start();
// 翻訳を中止する：頼んでいる翻訳を取り消し、Worker は書いたページまでで止める（訳したPDFは保存できる）
$('stop').onclick = () => {
  if (!running || !worker) return;
  stopping = true;
  $('stop').disabled = true;
  status.textContent = '翻訳を中止しています';
  worker.postMessage({ type: 'stop' });
  batches.cancel();
};
$('show-trans').onclick = () => store.setMode('translated');
$('show-orig').onclick = () => store.setMode('original');
$('zoom-in').onclick = () => { viewer.currentScale = Math.min(5, viewer.currentScale * 1.2); };
$('zoom-out').onclick = () => { viewer.currentScale = Math.max(0.25, viewer.currentScale / 1.2); };
// 保存するのは、画面に出している訳したPDFそのもの（訳している途中でも、その時点で訳文に替わったページまで）
$('save').onclick = () => {
  if (!worker) return;
  $('save').disabled = true;
  if (!running) status.textContent = STAGES.save;
  worker.postMessage({ type: 'save' });
};
$('open').onclick = () => $('file').click();
$('file').onchange = () => openFile($('file').files[0]);
const pick = $('pick');
document.addEventListener('dragover', (e) => { e.preventDefault(); pick.classList.add('drag'); });
document.addEventListener('dragleave', () => pick.classList.remove('drag'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  pick.classList.remove('drag');
  openFile([...e.dataTransfer.files].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)));
});

const src = new URLSearchParams(location.search).get('src');
if (src) openUrl(src);
