# 完了結果を先に渡すパッチ

`0001-drain-results-before-decode.patch` は、`get_result` が未読の結果を先に取り出し、結果が空のときだけ全スロットの生成を1ステップ進める変更である。同時8本の最初の完成結果を約1.205秒から約0.90秒へ早める見込みで、同じ8本の全体時間は約1.21秒を見込む。

対象は wllama `6647c1ea3837b2f0205a300c3bf5ff644aaa06bf`、llama.cpp `7d7f0287530bc8981690f361d8c1627dbae1c99a`。`commands,sampling,matmul,result` の順に指定する。`profile` はビルド側が最後に適用する。

## 原因とコードの経路

原因は、C++ glue の `cpp/wllama-context.h::action_get_result` が、結果キューを確認する前に毎回 `run_loop()` を呼ぶことにある。1回の呼出しで全スロットを生成し、問い合わせた1本の1チャンクだけを読む。8本同時なら、各リクエストは8ステップ分のチャンクを生成する間に1チャンクだけを読むため、未読の結果が積み上がる。

固定版での経路は次のとおり。

1. `extension/offscreen/offscreen.js::complete` は `stream: true` で `createCompletion` を呼ぶ。`src/wllama.ts::getResponse`（1496行）は各リクエストについて `get_result` を繰り返し、`has_more: false` になると呼出しを完了する。
2. `src/worker.ts::ProxyToWorker.wllamaAction` は問い合わせを worker へ送る。`src/workers-code/llama-cpp.js::runWasmCall` は JSPI の再入を防ぐ FIFO で呼出しを直列化する。`get_result` の往復約180msは、ほかの7本の問い合わせも生成を進めることによる順番待ちを含む。
3. `cpp/wllama-context.h::action_get_result`（1430行、問題の呼出しは1447行）は `run_loop()` を実行してから `get_next_result(rd)` を1回だけ呼ぶ。`run_loop`（696行）は `ctx_server.start_loop()` を経て全スロットを更新する。
4. llama.cpp の `tools/server/server-context.cpp::send_partial_response`（2351行）は開始通知とトークンの途中結果を送る。`send_final_response`（2406行）は完了結果を送る。通常の停止経路は `process_token` が停止した同じ更新内で `send_final_response(slot); slot.release();` を実行する（4928～4932行）。
5. wllama が上書きする `server_response::send` は結果を `queue_results` へ積み、`server_response::recv` は指定された task ID の結果を先頭から1個だけ取り出す。`server_response_reader::next`（1843行）は stop 結果を読んだ時点で `received_count` を増やす。`has_next`（1836行）が偽になるまで、JS は完了を待つ。

したがって、スロットは短い生成が終わった時点で解放される。完了結果はその時点で送信キューにあるが、先に積まれた途中結果を読み終えるまで呼出しが完了しない。worker の直列化は必要な契約で、今回のパッチはそれを保つ。

## round2 による照合

根拠は `profiles/1794239104063/candidate-0.8B-visit0-round2.json`。時刻は最初の worker step の `startMs = 1794239137981.345` を0とする。action event の受信時刻がないため、表の現行値は対応する最終 poll の worker step 終端である。`round.firstMs = 1205.3ms`、`round.ms = 1212ms` は背景側で完成結果を受け取った時間である。

| requestId | server task ID | トークン | 最後の生成 step 終端 ms | 現行の最終 poll の step 終端 ms | 修正後の完了予測 ms |
| --- | --- | --- | --- | --- | --- |
| 18 | 128 | 42 | 1013.20 | 1207.43 | 1084.91 |
| 19 | 129 | 39 | 951.98 | 1206.26 | 1020.33 |
| 20 | 130 | 48 | 1119.43 | 1209.24 | 1174.06 |
| 21 | 132 | 33 | 819.70 | 1203.22 | 900.54 |
| 22 | 134 | 46 | 1119.43 | 1208.95 | 1164.81 |
| 23 | 136 | 35 | 920.27 | 1204.98 | 943.73 |
| 24 | 137 | 42 | 1075.76 | 1208.06 | 1101.83 |
| 25 | 138 | 51 | 1181.49 | 1210.06 | 1207.66 |

task ID は登録順に対応付けた。各 task が `sequences` に現れる回数は、結果のトークン数 `[42,39,48,33,46,35,42,51]` と全件一致する。33トークンの task 132 は step 747 の終端819.695msで最後のサンプリングを終える。次の step 748 から行数が8から7へ減る。

`get_result` は352回、worker step も352個で、各 poll に必ず1 step が付く。生成を含む54 stepの後に、0トークンの idle が298 step続く。最後の生成 step 767 は1181.495msで終了し、最後の idle step 1065 は1210.060msで終了する。末尾の壁時計時間は28.565ms、idle step 自体の合計実行時間は2.404msである。

各リクエストの poll 回数はトークン数＋2と一致する。8本合計336トークンに、開始通知8個と完了通知8個を加えた352回で、`empty: true` は各本の開始通知1個ずつである。生成後の idle 298回は、溜まった通知を読む際にも生成ループを無条件に動かすことで生じる。このログでは空応答の高速ポーリングも無限ループも発生していない。

## 変更と数値予測

変更は `action_get_result` の結果取得順だけである。最初に `get_next_result(rd)` を呼び、結果が空なら `run_loop()` を1回実行して再読する。既存の結果変換、エラー判定、`has_more`、reader の破棄処理をそのまま使う。offscreen の変更は不要である。

`verify.mjs` は記録された54生成 stepの所要時間と task 所属、352回の poll 順を固定してキューを再生する。各 task の最初の step で開始通知、各サンプルで途中結果、最後の step で完了結果を積む。現行方式の352回すべてについて `empty` と照合し、結果を余さず読み切れることを確認する。修正方式でも同じ照合が通り、生成 step は54個、idle は0個になる。

観測された非 step 時間を352回で割った0.1111msを各 poll の固定費として足すと、最初の完成は900.54ms、全8本は1207.66msとなる。背景への通知など計測基点外の約2～4msを加え、`round.firstMs` は約0.90秒、`round.ms` は約1.21秒を中心値とする。33トークンの生成終了819.70msに残る約81msは、既に並んだ問い合わせがほかの生成 step を進める順番待ちである。

固定費を0.08～0.15msで振ると、最初の完成は892～911ms、全体は1197～1221msとなる。0.25msでは939msと1257msになる。実機では、結果の到着順に伴う次の poll の投入時点や初期バッチの組合せも変わるため、これらは反実仮想の予測値である。

受入の目安は、同じwarm条件で最初の完成が0.85～0.95秒、全体が1.19～1.25秒、生成終了後の idle がほぼ0となること。全体時間の主成分である生成1168.56msは残り、352回の結果取得も残る。末尾28.565msの通知処理は生成の合間へ移るため、全体の短縮予測は idle の実行約2.4msを中心とする。

`round.firstMs` は8本のうち最初の**完成結果**までの時間である。offscreen が測る最初のストリームチャンクまでの `firstMs` と意味が異なる。修正後の最初のチャンクは約65ms、33トークンを生成する本では約149msを予測する。

## 検証と統率者の実行

固定版の Git object から作った隔離コピーで、`commands` 3個、`sampling` 3個、`matmul` 1個、`result` 1個、現行 `profile` 2個の全10パッチについて `git apply --check` と適用を確認した。候補適用後のGPU計測挿入も成功した。元 checkout と別担当の profile は変更していない。

ローカル再検証は、wllama と llama.cpp の各 Git リポジトリ、および round2 JSON を引数に渡す。

```powershell
node tools/wllama/patches/result/verify.mjs $WLLAMA_REPO $LLAMA_CPP_REPO $ROUND_JSON
```

統率者のビルドコマンドは、PLaMo翻訳プロジェクト直下で次の1行である。

```powershell
node tools/wllama/build.mjs --variant profile --patches tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/matmul,tools/wllama/patches/result
```

ビルドが返す `artifactId` を `tools/profile.mjs` の候補へ指定し、同時8本の既存warm条件で計測する。生成テキスト・トークン・cut の一致、各本の最終 poll 時刻、`round.firstMs`、`round.ms`、idle step 数を比較する。sandbox では Docker ビルドとBraveの実測を統率者が担当する。
