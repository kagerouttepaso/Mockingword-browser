# Workerとネイティブログの取得

profileの各セッションでRuntimeとLogを有効にし、offscreenとblob URLの子Workerが出したコンソール・例外をbrowser.jsonlへ保存する。共有モデル供給が既に使っているautoAttachと同じCDP接続で動く。ログ設定が完了するまでWorkerの実行再開を待つため、読み込み直後の検証エラーも取得対象になる。

## 再現コマンド

拡張のディレクトリで次の1行を実行する。ビルド済みH5を使い、以前失敗した実行と同じcompletion設定を適用する。

```powershell
node tools/profile.mjs --models 0.8B --variants baseline-candidate-f5f7ff65e7c1 --native-log --parallel 8 --quality-replays 0 --completion-extra @tools/profile/completion/h5-native-log.json
```

比較計測では既存のreference・candidate指定にもnative-logを追加できる。native-logは全caseの計測用コピーでsuppressNativeLogをfalseにする。リポジトリの拡張とビルド成果物はそのまま使う。ログの増加による計測負荷を含むため、この実行は障害診断に使う。

## 保存する内容

| ファイル | 内容 |
| --- | --- |
| 各セッションのbrowser.jsonl | Runtime.consoleAPICalled、Runtime.exceptionThrown、Log.entryAdded、Inspector.targetCrashedのCDPパラメーター全文。sessionId、targetのtype・URL・targetId、受信時刻を付ける |
| 各セッションのdiagnostics.json | ターゲット一覧、イベント件数、重要メッセージの先頭10件、ログ設定の失敗 |
| report.json | 成功runのdiagnostics、停止したセッションのfailedSessions。初期生成で失敗しても診断を残す |
| summary.md | error・warn・warning・assert、またはggml / WebGPU / WGSLを含むメッセージの先頭10件。targetと本文を表示する |

Errorオブジェクトではdescriptionに加えてpreviewのmessage等を取り出す。summaryでは改行を保持して表示し、browser.jsonlには元の引数を保存する。同じターゲットの同一level・本文が重複した場合、summaryでは1件にまとめる。

WorkerがLogドメインに対応していない場合は、非対応をbrowser.jsonlへ記録してRuntimeのコンソール取得を続ける。それ以外の設定失敗はdiagnosticsのfailuresとsummaryへ出す。GPU異常後のブラウザー終了にも失敗した場合、最初の例外を保持し、終了時のエラーはcleanupErrorへ分ける。

## 初期化順と検証

Target.attachedToTargetを受けたら、Runtime.enable、Log.enable、子ターゲットへのTarget.setAutoAttachを実行する。flattenとwaitForDebuggerOnStartを有効にし、workerを含む対象へ再帰的に設定する。モデル供給側がRuntime.runIfWaitingForDebuggerを送る場合も、この設定の完了を待たせる。[CDPのTarget仕様](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Target.pdl)の再帰アタッチ・実行再開の契約に合わせている。

実際のH5の検証メッセージは、新しいコマンドのBrave実行で取得する。旧ログに本文がない実行は、再計測で本文を取得する。
