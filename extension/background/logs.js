// 調査用のログ。設定の「調査用のログ」がオンのときだけ、ページ・裏方・モデルの出来事を時刻付きで残す
// （直近3000件。裏方が止まると消える）。設定画面から JSON で保存できる。ページの文は先頭60字だけ残し、外へは送らない。
// 使い方と読み方は docs/06_開発と検証.md「調査用のログ」。

const LIMIT = 3000;
export const logs = [];
let enabled = false;

chrome.storage.sync.get({ debugLog: false }).then((s) => (enabled = !!s.debugLog));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'sync' && c.debugLog) enabled = !!c.debugLog.newValue;
});

export function addLog(source, event, data) {
  if (!enabled) return;
  logs.push({ time: new Date().toISOString(), source, event, ...data });
  if (logs.length > LIMIT) logs.splice(0, logs.length - LIMIT);
}

export function clearLogs() {
  logs.length = 0;
}
