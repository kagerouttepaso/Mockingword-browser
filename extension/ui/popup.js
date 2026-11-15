// ツールバーのボタンを押したときのメニュー。ページの翻訳・表示の切り替え・テキスト翻訳・モデルの切り替えと解放・設定。
// ページへの差し込みは裏方が行う（メニューを開いたタブには activeTab の権限が付く）。
import { DEFAULTS, MODEL_LABELS, describeStatus } from '../shared/settings.js';
import { MSG } from '../shared/messages.js';

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const send = (message) => chrome.runtime.sendMessage(message);

/** ブラウザーの内部ページ（brave:// など）や拡張機能のページは訳せない。 */
const translatable = /^(https?|file):/.test(tab?.url ?? '');
for (const button of document.querySelectorAll('#page, [data-show]')) button.disabled = !translatable;
if (!translatable) document.getElementById('page').textContent = 'このページは訳せません';

// 訳しているページなら、メインのボタンを「元のページに戻す」にする（ページ側の部品が無ければ訳していない）。
const translating = translatable && (await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATE }).then((r) => r?.translating, () => false));
const pageButton = document.getElementById('page');
if (translating) pageButton.textContent = '翻訳をやめて元のページに戻す';
pageButton.onclick = async () => {
  await send({ type: MSG.PAGE_ACTION, tabId: tab.id, action: translating ? 'stop' : 'toggle' });
  window.close();
};
for (const button of document.querySelectorAll('[data-show]')) {
  button.onclick = async () => {
    await send({ type: MSG.PAGE_ACTION, tabId: tab.id, action: button.dataset.show });
    window.close();
  };
}
document.getElementById('text').onclick = async () => {
  await send({ type: MSG.OPEN_TEXT });
  window.close();
};
document.getElementById('options').onclick = () => {
  chrome.runtime.openOptionsPage();
  window.close();
};

const model = document.getElementById('model');
for (const [value, label] of Object.entries(MODEL_LABELS)) model.append(new Option(label, value));
model.value = (await chrome.storage.sync.get(DEFAULTS)).model;
model.onchange = async () => {
  // 訳したページなら新しいモデルで訳し直す。
  await send({ type: MSG.SWITCH_MODEL, model: model.value, tabId: translatable ? tab.id : null });
  render();
};

const unload = document.getElementById('unload');
unload.onclick = async () => {
  unload.disabled = true;
  await send({ type: MSG.UNLOAD });
  render();
};

async function render() {
  const s = await send({ type: MSG.STATUS });
  document.getElementById('status').textContent = describeStatus(s);
  unload.disabled = !s?.loaded && !s?.loading;
}
render();
