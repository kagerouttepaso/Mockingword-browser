// テキスト翻訳のページ。入れた文章を、ページの翻訳と同じブラウザー内のモデルで日本語に訳す。
// 入力が止まって0.8秒たつか、Ctrl+Enter・「翻訳」で訳す。原文の言語はこのページだけの選択（ページの翻訳には効かない）、文体は設定と共有する。
import { DEFAULTS, fillLanguages } from '../shared/settings.js';
import { MSG } from '../shared/messages.js';

const $ = (id) => document.getElementById(id);
const input = $('input');
const output = $('output');
const source = $('source');
const form = $('form');
const foot = $('foot');

fillLanguages(source, '言語を自動で判定');
const saved = await chrome.storage.sync.get(DEFAULTS);
form.value = saved.form;
// 下書きと原文の言語は、このページの中にだけ残す（タブを閉じても戻せるように）。
try {
  input.value = localStorage.getItem('draft') ?? '';
  source.value = localStorage.getItem('source') ?? '';
} catch {}

/** 新しい依頼を出すたびに増やす。前の依頼の返事が後から届いても捨てる。 */
let generation = 0;
/** 訳している依頼の途中経過の番号。訳していなければ空。 */
let stream = '';
let lastKey = '';

async function translate() {
  const text = input.value.trim();
  const key = `${source.value}|${form.value}|${text}`;
  if (key === lastKey) return;
  lastKey = key;
  const mine = ++generation;
  if (!text) {
    setOutput('訳文がここに出ます', true);
    foot.textContent = '';
    return;
  }
  foot.textContent = '翻訳中…';
  const t0 = performance.now();
  // stream：Service Workerが訳文の途中と生成したトークン数を0.1秒おきに知らせてくる（下の onMessage）。ほかのテキスト翻訳のタブと混ざらない番号にする。
  stream = `${Date.now()}-${mine}`;
  const r = await chrome.runtime.sendMessage({ type: MSG.TRANSLATE_ONE, text, source: source.value, lines: true, stream }).catch((e) => ({ ok: false, error: e.message }));
  if (mine !== generation) return;
  stream = '';
  $('notice').textContent = '';
  if (r?.ok) {
    setOutput(r.text, false);
    const sec = (performance.now() - t0) / 1000;
    foot.textContent = `PLaMo ${r.model}・${sec.toFixed(1)}秒` + (r.tokens && r.genMs ? `・${r.tokens}トークン・${(r.tokens / (r.genMs / 1000)).toFixed(1)} tok/s` : '');
  } else {
    lastKey = ''; // 失敗したら、もう一度押せば訳し直す
    foot.textContent = r?.error ?? '翻訳に失敗しました。';
  }
}

function setOutput(text, placeholder) {
  output.textContent = text;
  output.classList.toggle('placeholder', placeholder);
}

let timer = 0;
input.addEventListener('input', () => {
  $('count').textContent = `${input.value.length} 字`;
  try {
    localStorage.setItem('draft', input.value);
  } catch {}
  clearTimeout(timer);
  timer = setTimeout(translate, 800);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    clearTimeout(timer);
    lastKey = '';
    translate();
  }
});
source.onchange = () => {
  try {
    localStorage.setItem('source', source.value);
  } catch {}
  translate();
};
form.onchange = () => {
  // 文体は設定と共有する（ページの翻訳も同じ文体にする）。
  chrome.storage.sync.set({ form: form.value });
  translate();
};
$('translate').onclick = () => {
  lastKey = '';
  translate();
};
$('clear').onclick = () => {
  input.value = '';
  input.dispatchEvent(new Event('input'));
  input.focus();
};
$('copy').onclick = async () => {
  if (output.classList.contains('placeholder')) return;
  await navigator.clipboard.writeText(output.textContent);
  $('copy').textContent = 'コピーしました';
  setTimeout(() => ($('copy').textContent = 'コピー'), 1500);
};
$('options').onclick = () => chrome.runtime.openOptionsPage();

// 初回のモデルの取得・読み込みの進み具合（Service Workerから）。
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === MSG.NOTICE) $('notice').textContent = message.text;
});

// 訳文の途中。訳し終わるのを待たず、出てきた分から見せ、生成の速さ（トークン/秒）を下に出す。
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== MSG.TEXT_PARTIAL || !stream || message.stream !== stream) return;
  if (message.text) setOutput(message.text, false);
  const sec = message.genMs / 1000;
  foot.textContent = `翻訳中… ${message.tokens}トークン` + (sec > 0.2 ? `・${(message.tokens / sec).toFixed(1)} tok/s` : '');
});

/** 選択範囲の訳の吹き出しから渡された文章を入れて訳す（Service Workerが storage.session に置く）。 */
async function takeText() {
  const { pendingText } = await chrome.storage.session.get('pendingText');
  if (!pendingText) return false;
  await chrome.storage.session.remove('pendingText');
  input.value = pendingText;
  input.dispatchEvent(new Event('input'));
  clearTimeout(timer);
  lastKey = '';
  translate();
  return true;
}
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === MSG.TAKE_TEXT) takeText();
});

$('count').textContent = `${input.value.length} 字`;
if (!(await takeText()) && input.value.trim()) translate();


// 読み取りは利用者が押したときだけ。新しい入力で、許可待ちの間に書いた文章を上書きしない。
$('paste').onclick = async () => {
  const button = $('paste');
  const before = input.value;
  const start = input.selectionStart;
  const end = input.selectionEnd;
  button.disabled = true;
  try {
    const text = await navigator.clipboard.readText();
    if (input.value !== before) {
      $('notice').textContent = '入力が変わったため貼り付けを中止しました。もう一度押してください。';
      return;
    }
    if (!text) { $('notice').textContent = 'クリップボードに文字がありません。'; return; }
    input.setRangeText(text, start, end, 'end');
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.focus();
    $('notice').textContent = '';
  } catch {
    $('notice').textContent = 'クリップボードを読めませんでした。入力欄でCtrl+V（Macは⌘V）を使ってください。';
  } finally { button.disabled = false; }
};
