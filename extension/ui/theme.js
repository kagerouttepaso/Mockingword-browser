// 拡張画面の明暗を設定と同期する。本文や下書きには触れない。
function applyTheme(theme) {
  const value = ['light', 'dark'].includes(theme) ? theme : 'system';
  document.documentElement.dataset.mwTheme = value;
}
applyTheme((await chrome.storage.sync.get({theme:'system'})).theme);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.theme) applyTheme(changes.theme.newValue);
});
