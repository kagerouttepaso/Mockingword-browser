# wllama のビルドと計測

> この文書は実験の記録で、書いた当時の条件・実装での計測と判断を残している。今の設計は [アーキテクチャ](02_アーキテクチャ.md)・[翻訳コア](03_翻訳コア.md)・[ページの翻訳](04_ページの翻訳.md)、採否の基準は [ページ翻訳のUX計測](13_ページ翻訳のUX計測.md)。

固定版の wllama を自分でビルドし、配布物との訳・速度の一致と、生成1 step の内訳を確認するための手順。成果物、ソース、ブラウザー用の拡張コピー、計測結果は、リポジトリ外の WORK に出す。

baseline の0.8Bの訳・速度を受入済み。profile と profile-gpu のビルド・内訳取得もホストで確認した。2Bの通常版の採否は、前後の基準を含む再計測で確定する。pins.json は image digest・Dawn SHA-256・npm の版を保存している。候補を重ねる入口と差分ビルドはオフライン検証済みで、ホストの確認を続ける。

## 固定する入力

| 部品 | 固定値と照合方法 |
| --- | --- |
| wllama | 3.13.0、6647c1ea3837b2f0205a300c3bf5ff644aaa06bf |
| llama.cpp | 7d7f0287530bc8981690f361d8c1627dbae1c99a。wllama の gitlink も照合 |
| emsdk | emscripten/emsdk:4.0.20。初回に image digest を取得し、以後は digest で指定 |
| Node | node:24.18.1-bookworm-slim。初回に image digest と npm の版を固定 |
| Dawn | v20260317.182325 の emdawnwebgpu_pkg ZIP。初回の SHA-256 を固定し、以後は毎回照合 |
| npm 依存 | wllama 3.13.0 の package-lock.json。SHA-256 を照合して npm ci |
| 比較する配布物 | vendor の README と pins.json にある index.js / wllama.wasm の SHA-256 |

Linux/amd64 の Docker エンジン、Git、Node 24、Brave を用意する。Windows の PowerShell から実行できる。ビルド用 OS パッケージの追加・更新は行わず、固定イメージ内の Git・CMake・Python・emscripten を使う。

WORK の既定は環境変数 LOCALAPPDATA の下の plamo-translate-build。PLAMO_BUILD_ROOT または各コマンドの --work-root で変更できる。WORK はリポジトリの外へ置く。Brave の場所を変える場合は BRAVE 環境変数で実行ファイルを指定する。

## baseline を作る

PowerShell で リポジトリのフォルダーへ移動し、次を順に実行する。最初のビルドは Git 履歴とコンテナーイメージを取得するため、通信と空き容量が必要になる。

```powershell
node tools/wllama/build.mjs --variant baseline
node tools/profile.mjs --models 0.8B --variants distribution,baseline
```

build.mjs は初回に不足している digest・hash を pins.json へ書く。取得値の差分を確認し、受入確認後に台本と一緒に管理する。2回目以降は固定値との不一致で停止する。取得だけを先に行う場合は --pins-only を指定する。

成果物を再利用できない場合は、新しい専用 checkout を作る。調査用 clone と配布フォルダーを変更せず、reset --hard / clean も行わない。Dawn は取得を再試行し、ZIP 先頭と SHA-256 を確認してから使う。ビルドの順序は次のとおり。

1. wllama の commit、llama.cpp の gitlink / commit、package-lock.json を照合する。
2. patches/build、追加候補、計測用の順に確認・適用する。追加候補は --patches のディレクトリ指定順、各ディレクトリ内はファイル名順。baseline には計測コードを入れない。
3. Docker 内で固定依存を準備し、upstream と同じ WebGPU・JSPI・memory64・O3・msimd128・pthread の WASM を作る。npm と Emscripten のシステム・port cache は volume に保持する。
4. 新しく作った wllama.js と wllama.wasm を src/wasm へ置く。build_worker.sh で新しい glue を Worker に埋め込み、その後に build:tsup を実行する。
5. 成果物と manifest を WORK/runs/baseline-時刻/artifacts に保存する。

成果物は index.js、wasm/wllama.wasm、build-manifest.json、toolchain.json。配布する2ファイルの形と、offscreen の default WASM URL 指定を保つ。manifest には入力、パッチと台本の hash、コンパイラーなどの版、成果物の hash・サイズを残す。

CMake と node_modules は Linux volume に置く。コンテナー内のソースパスは /source、SOURCE_DATE_EPOCH は固定 commit の時刻にそろえる。ソース同期は内容が違うファイルだけを書き、同じ内容のmtimeを保つ。候補を外したファイルも専用checkoutの基準内容へ戻す。

入力hashはpins・variant・順序付きのパッチSHA・台本を含む。同じ入力の成果物はファイルSHAを検証して再利用する。構成hashはpins・Dockerfile・variant・CMake設定とCMakeを変えるパッチから決まり、通常のコード変更では同じCMakeフォルダーを使う。構成が変われば別フォルダーでビルドする。--rebuild は成果物再利用だけを外し、--clean はその構成のCMakeビルドを作り直す。

## 計測版を作る

baseline の翻訳・速度を確認してから profile を作り、同じモデルと設定で測る。

```powershell
node tools/wllama/build.mjs --variant profile
node tools/profile.mjs
```

profile.mjs の既定は、両モデルについて distribution → baseline → profile → baseline → distribution の順で測る。各起動は新しいプロファイルで、ウォームアップ1回と3回の計測をまとめて行う。モデルは固定URL・サイズ・SHAを共有キャッシュで確認し、同じバイトをローカルから供給する。取得・照合は測定前にモデルごとに1回行う。

共有キャッシュの既定は LOCALAPPDATA 配下の plamo-translate-build/models。PLAMO_MODEL_CACHE または --model-cache で変更できる。PLAMO_MODEL_CACHE_OFFLINE=1 では未準備のモデルを取得せず停止する。準備用は tools/lib/model-cache.mjs、接続確認用は tools/lib/model-cache-probe.mjs。Fetchを持たないWorkerでは実行前のfetchフックを使い、漏れはNetwork監視と供給量の確認で検出する。

```powershell
node tools/profile.mjs --models 0.8B --variants baseline,profile
node tools/profile.mjs --models 2B --variants baseline,profile --parallel 4 --ubatch 512 --device gpu
```

profile.mjs は開始時の extension を WORK へコピーし、そのコピーだけで vendor を入れ替える。さらに、コピーへ計測用の hook と実行口を追加し、既存の tune.js の SAMPLE を共有する。manifest の権限と配布する extension は維持する。

測定は tools/tune.mjs と同じ8バッチを使い、モデルの読み込みとウォームアップ1回を除き、3回の中央値・ばらつき・最初のバッチまでの時間・tokens/s を出す。追加のマーカーつき文章は、時間測定が終わってから訳す。通しの e2e は実行しない。

結果は WORK/profiles/時刻 に保存する。

| ファイル | 内容 |
| --- | --- |
| report.json | 設定、Brave の版、GPU の情報、n_vocab、3回の結果、build manifest、台本と拡張コピーの hash、比較 |
| summary.md | 総時間、上乗せ、内訳、代表 decode step の短い表 |
| 版-モデル-round番号.json | 訳文、raw イベント、全 step、prefill/decode/mixed 別集計、JS 往復 |
| 版-モデル-quality-replays.json | 指定した場合に行う、速度測定後の訳の追加試行 |
| 版-モデル-browser.jsonl | CDP で得た console と例外 |
| snapshot・extensions | 比較に使った拡張コピー |

現在のファイル名は case-モデル-visit番号 を接頭辞に持つ。report.json の schedule と runs[].visit で前後の基準を区別する。各visitの中央値・ばらつきは元と同じ3回の実測から計算し、複数visitの時間を合成しない。訳の変動集合は同じcaseの実測をまとめる。基準速度の過去値は、熱や時間による揺れを十分に評価できていないため再利用しない。

## 候補を重ねて1周を回す

```powershell
node tools/bench-loop.mjs --candidate tools/wllama/patches/commands --models 0.8B
node tools/bench-loop.mjs --variant profile --candidate 'tools/wllama/patches/commands,tools/wllama/patches/sampling' --models 0.8B
```

候補の成果物IDは variant-candidate-パッチhash となり、基準の latest/baseline.json や latest/profile.json を上書きしない。基準成果物は既存の照合済みのものを使う。計測は基準 → 候補 → 基準。前後の基準の各3回中央値で照合し、5%と実測のばらつきの大きい方を超える改善を両方で確認する。計測版・GPU timestamp版・token診断では通常速度の採否を出さない。

```powershell
node tools/wllama/build.mjs --variant profile --patches 'tools/wllama/patches/commands,tools/wllama/patches/sampling' --plan
node tools/profile.mjs --reference profile --candidate <表示された成果物ID> --models 0.8B
```

候補の後では元のGPU計測パッチが当たらない場合があるため、ビルド入口は固定パッチのGPU部分を分離し、候補適用後のAPI位置へ計測を入れる。bindGroupはcache miss時のCreateBindGroup、writeBufferはarena.flushとwrite_buffer内の実API、submitは実Submitを数える。queueWaitは早期return後に置く。候補側の投入・完了保証は変更しない。

## samplingの追加項目とtoken診断

Windows PowerShellでJSONの引用符が失われる場合は、JSONファイルを @FILE で渡す。基準と候補で別々の追加項目を指定できる。prompt・stream・温度など測定の基本条件の上書きは停止する。

```powershell
node tools/profile.mjs --reference profile --candidate profile --completion-extra '@tools/profile/completion/backend-sampling.json' --models 0.8B
node tools/bench-loop.mjs --variant profile --candidate tools/wllama/patches/sampling --completion-extra '@tools/profile/completion/token-only.json' --models 0.8B --tokens
```

--tokens は verbose:true と return_tokens:true を両側へ追加する開発用モード。通常速度はこのモードを外して測る。7d7f028のstreamではpartialに各token、finalに空配列が来るため、partialとfinalを二重に数えない。生のchunkと導出した列をround JSONへ残し、usageとの個数差も記録する。tensorRead・mapWaitの回数と時間、hostCopy.bytesはケース別の表で比較する。

## 1周の時間を確認する

buildの工程は WORK/logs/build-variant-時刻-timings.json、CMake・C++・JSなどのコンテナー内訳は build manifest の containerTimings に残す。compiledObjects、sourceFilesCopied、各cache hitも記録する。成果物再利用時には過去のコンパイル時間を今回の時間へ混ぜない。Docker外枠はホストの所要時間からコンテナー内の所要時間を引いた値で、起動・終了・転送を含む。

計測は拡張コピー、Brave接続・拡張準備、共有モデル準備、読込み、ウォームアップ、計測本体、後片付けを記録する。モデルURL読込みの内側でloadModelを計測できた場合はnative読込みも示す。計測値そのものにはブラウザー内の8バッチの時間を使い、セットアップ時間は加えない。

```powershell
node tools/profile/cycle-compare.mjs --loops '<1周目の結果フォルダー>,<2周目の結果フォルダー>'
```

1周目と同じ入力の2周目、その後のコード差分の周を比べる。models・parallel・追加項目・比較順をそろえ、初回構成、差分コンパイル、成果物再利用を区別する。親工程は子工程を含むので、表の列を単純加算して全体時間にしない。

baselineVsDistribution.translationsMatch は訳文そのものの完全一致を示す。token 数と cut の一致は translations.tokenCountsMatch / cutStatesMatch に分ける。版内の変動は translations.referenceVariation / candidateVariation に残す。differences は異なるバッチ・行・実際の訳文を示す。

訳の受入は translationsAccepted で確認する。全試行の完全一致は exact、基準版でも実際に得られた別訳の範囲なら observed-reference-variation とする。後者は、候補の全別訳を基準版で観測し、1回あたりの変動バッチ数が基準版の最大値以内で、両版とも打ち切りがない場合に限る。候補版だけに出た別訳は review-required で停止する。

qualityMatch は追加のマーカーつき文章の一致、markersPreserved は a1 / a2 の両マーカーを確認する。withinVariation は、時間差が両版のばらつきと5%の大きい方に収まるかを示す。profileOverhead.delta は baseline に対する profile の中央値の増加率で、計測コードの上乗せを判断する材料になる。

訳文・マーカーの保持、または baseline の速度の照合に通らない場合は、結果を保存して終了コード2を返す。report.json の acceptance と比較値を確認して採否を決める。usage の token 数を取得できなかった回は tokenFallback を記録し、表の tokens/s を「取得不能」と表示する。

別訳の原因を調べる場合は、同じ8バッチの追加試行を指定する。追加分はウォームアップ後の速度3回の中央値・ばらつきに含めず、版内・版間の訳の比較へ使う。基準版でも同じ別訳が出ることを確認するために使う。

```powershell
node tools/profile.mjs --models 0.8B --variants distribution,baseline --parallel 4 --quality-replays 12
```

同時実行の影響を切り分ける補足確認には --parallel 1 を使う。この結果は同時4本の結果と別の report.json に保存する。版間が一致するか、版内で揺れ続けるかを、同じ指標で確認する。

```powershell
node tools/profile.mjs --models 0.8B --variants distribution,baseline --parallel 1
```

WASM 自体が異なる場合は、section と関数本体を次の台本で比較できる。引数には配布物と専用ビルドのファイルを指定する。JS・commit・パッチ・コンパイル設定と合わせて、差のある関数が通常の推論へ影響するかを判断する。

```powershell
node tools/profile/wasm-diff.mjs --reference extension/vendor/wllama/wasm/wllama.wasm --candidate '<成果物フォルダー>/wasm/wllama.wasm'
```

## 1 step の内訳を読む

step は wllama の run_loop 1回で、decodeStepId を持つ。空の get_result も残し、実際の wasmDecode.count と分けて数える。並列4本が同じ step で進んだときは、step の経過時間と、sampling 回数で割った1 token あたりの時間を併記する。sampling 回数は EOS も含むため、usage の completion_tokens と区別する。

phase と sequences の取得は profile / profile-gpu 共通の計測パッチで行う。

| 項目 | 読み方 |
| --- | --- |
| phase・sequences | token の is_prompt で prefill / decode / mixed / idle を分類する。id_slot を sequence・requestId に対応付け、poll の対象 requestId と分ける |
| wasmDecode | server の llama_process(DECODE) と直後の既存同期までの時間 |
| webgpuBuild | bind group、引数書込み、encoder 作成を含む GPU 投入準備 |
| bindGroup・writeBuffer・submit | API ごとの時間と回数。writeBuffer はバイト数も取得 |
| queueWait・mapWait・eventWait | キュー完了、Map、event の既存待機時間 |
| logitsRows・logitsBytes | 通常 logits の読取り要求。4 × n_vocab × 実際の出力行数と照合する |
| tensorRead・hostCopy | KV なども含む読取りとホストへのコピー。hostCopy.bytes は実際のコピー量 |
| sampling | 翻訳で使う sampler 呼出しの経過時間 |
| actionTiming・js | encode、Worker 内、glue decode、Worker の外側の往復とキュー待ち、空 poll |

これらの時間には包含関係がある。webgpuBuild は bindGroup / writeBuffer、tensorRead は Map 待ちを含む。queueWait / Map 待ちは GPU 実行とブラウザー通知を含み、sampling にも遅延同期が入り得る。並列 JS 要求どうしの区間も重なる。値は経過時間・回数・バイトとして比較し、全項目を加算して100%の内訳を作らない。

profile は step の JSON 化と Worker 転送を追加する。代表 step の短い表は、第2回の純粋な decode step から1 token あたりの時間が中央値のものを選ぶ。後段の変更は総時間を baseline でも測り、profileOverhead と合わせて判断する。

GPU カーネルの timestamp が必要なら別の profile-gpu を使う。

```powershell
node tools/wllama/build.mjs --variant profile-gpu
node tools/profile.mjs --models 0.8B --variants profile-gpu
```

profile-gpu は upstream の GGML_WEBGPU_GPU_PROFILE を有効にする。pipeline 名別の timestamp は round JSON の analysis.gpu へ残す。対応する GPU の timestamp-query 機能が必要になる。このモードは compute pass と同期を増やすので、カーネルの所在を調べるために使う。

## 後段の変更を選ぶ

最初の実測で支配項を確定し、次の基準で優先順を見直す。現時点で実測の配分は未取得のため、この段階の成果は計測できる台本とパッチである。

| 観測 | 次に評価する変更 |
| --- | --- |
| bindGroup / WriteBuffer の回数と投入準備が大きい | bind group の再利用・引数書込みの一括化 |
| logits の大量読取り、queue / Map 待ちが大きい | 完了保証を保つ重複同期の削減、必要な token ID を読む sampling 経路 |
| decode の GPU 行列演算が大きい、特に5本以上 | MMVQ と必要な一時領域の拡張 |
| KV など logits 以外の hostCopy が大きい | checkpoint / prompt cache の発生箇所と公開 JS 設定の伝達確認 |
| Worker 外の往復・空 poll が大きい | 結果のまとめ受取り、poll の削減 |

同期、MMVQ、KV、sampling の最適化は別パッチとして加え、各変更を baseline の速度と訳文で評価する。sampling を変える場合は同点選択、マーカー、出力 token 列も照合する。

## 失敗したときと別 PC での再開

ビルドが失敗したら、WORK/logs の該当 build ログ、コマンド、pins.json の差分、Docker の版と Linux エンジンの状態を確認する。メモリー不足なら --jobs 4 で新しい専用 checkout に作り直せる。途中成果物とログは残り、最新成果物への参照は成功時だけ更新する。

ビルド中の同時実行は WORK の .build-lock で止める。プロセスが終了した後も lock が残った場合は、その WORK で動いている build がないことを確認して lock ファイルだけを除く。既存 checkout や配布フォルダーの初期化は不要。

ブラウザー計測が失敗したら、表示された結果フォルダーの report.json、browser.jsonl、round JSON を確認する。native step が届かない場合も round JSON を保存してから停止する。Brave の CDP ポートを他の作業が使っている場合は --port で変更する。

別 PC では固定済み pins.json を含むこのフォルダーを取得し、Node・Git・Docker Desktop・Brave を用意する。baseline → profile → profile.mjs の順に実行すると、その PC の環境変数から WORK が決まる。個別 PC のパスや GPU 名は、WORK に出る計測結果へ記録する。

採否の関門（訳文・打ち切り・マーカーの照合）を変えたら、次のコマンドで確かめる（`docs/06`「常設の単体試験が守るもの」）。

```powershell
node --test tools/profile/comparison.test.mjs
```

出典と MIT 本文は tools/wllama/licenses にまとめた。Dawn 取得の再試行は sakutto の0006を参考に Node の取得経路へ移植し、Copyright (c) 2026 jammaru と MIT 本文を残している。

## 別のPCで始める

Windows で このリポジトリを取得 し、Node 24 以上・Git for Windows・Docker Desktop・Brave を用意する。Docker Desktop の Linux エンジンを起動してから、リポジトリ直下 直下で次を実行する。

```powershell
node tools/setup-bench.mjs
```

- 前提（Node・Docker の応答・Brave の実行ファイル・Git）を確かめ、`tools/wllama/pins.json` の固定版から、基準の baseline と、同梱した版と同じ並び（commands→sampling→matmul→result→prefill→matmul-h8→attn）の通常版をビルドする。`core.longpaths=true` は子プロセスだけに渡し、Git の全体設定は変えない。
- 作業領域の既定は `%LOCALAPPDATA%\plamo-translate-build`、0.8B モデルの共有キャッシュは `WORK/models`。取得後に SHA-256 を照合する。PC ごとのパスは実行時に求め、成果物・モデル・結果はリポジトリの外に置く。
- 最後に `profile.mjs` を1回起動し、0.8B・キャッシュなしで基準→候補→基準を交互に測る。基準は配布物と同じ設定（`backend_sampling:false`・`samplers:null`）、候補は拡張の既定の設定。`--parallel 8` で同時8本、`--skip-check` で確認計測を省く。終了時に `WORK/profiles/<時刻>/summary.md` の場所を出す。
- 2回目以降も同じコマンドでよい。ビルドは入力 hash と成果物の SHA、モデルは SHA が一致すれば再利用する（検証環境Aで2回目は約1秒）。確認計測は毎回新しく行う。
- 保存先は `PLAMO_BUILD_ROOT`／`--work-root`、モデルは `PLAMO_MODEL_CACHE`／`--model-cache`、Brave は `BRAVE` 環境変数で変えられる。メモリー不足は `--jobs 4`、ポートの競合は `--port 9351`。
- 終了コード1は前提不足や処理の失敗で、対処を表示する。終了コード2は訳・マーカーに要確認の差がある状態で、`summary.md` と `report.json` を見て判断する。工程の記録は `WORK/logs/setup-bench.json`。
- 内蔵GPU（Radeon 860M など）で WebGPU が別の adapter を選ぶときは、結果の adapter 名を `summary.md` で確かめる。
