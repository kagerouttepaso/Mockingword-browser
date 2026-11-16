// Service Workerが chrome.scripting.executeScript で差し込む読み込み役（通常のスクリプト）。
// ページ側の本体は ES モジュール（page/main.js）なので、ここから import する。二重に差し込まれても1回だけ読み込む。
// 最後の式の Promise を executeScript が待つので、Service Workerは読み込みが終わってからメッセージを送れる。
// import する page/・shared/ のファイルは manifest の web_accessible_resources に入れてある。
(window.__plamoPage ??= import(chrome.runtime.getURL('page/main.js')).then(() => true));
