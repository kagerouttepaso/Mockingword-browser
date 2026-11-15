# 温度0のtoken-only samplerをスロットに保持する（N1）

`0001-keep-token-only-slot-samplers.patch` は、既存の `sampling` を含む8フォルダー13パッチの後へ当てる。2026-11-11 に同梱した（`baseline-candidate-eeff57105463`。検証環境Aの実際のページで全体 -4.5%）。固定版は wllama `6647c1e` / llama.cpp `7d7f028`。`prefill-small-n` と独立して試せる。

## 原因と変更

拡張の `offscreen.js` は生成要求へ `backend_sampling: true`、`backend_sampling_token_only: true`、`samplers: ['temperature']`、`temperature: 0` を指定している。

固定版の `server-context.cpp` は要求ごとに `common_sampler_init` でsamplerを作り、`llama_set_sampler` で登録する。終了・取消による `server_slot::reset` では登録を外す。`llama-context.cpp` の `set_sampler` は、登録・削除のたびに `sched_need_reserve = true` とする。その後の `sched_reserve` は同期・schedulerの作り直し・pp/tg/ppの3つの予約グラフを作り、実際のグラフと合わせて構築が4回となる。

候補は、テキスト生成用の全スロットへgreedy＋token-onlyのsamplerを先に作って登録する。モデル慣らし後のスロット初期化時に全件を登録し、最初の推論時の予約へまとめる。要求の設定値は保持する。

対象の生成要求では、既存の厳しいtoken-only適格判定を通し、さらにsampler列がtemperatureだけであることを確認して、スロットのsamplerと登録を使い続ける。`init_sampler()` による履歴のresetと原文のacceptは従来どおり行う。終了・取消でスロットが空いても、登録と所有権を保つ。空いているsequenceは出力を持たないため、追加のGPU samplingは発生しない。

確率出力・文法・温度変更・penalty・複数samplerなど、条件を外れる要求は新しいsamplerへ付け替える。旧samplerを解放する前に登録を外し、以後は従来のreserveとfallbackを使う。sampling不要の要求も登録を外して解放する。投機的デコード、multimodal、embeddingのモデルでは先行登録を行わない。

docs/10の `params.samplers` 案と同じく、最初から全スロット分を予約する方針を採る。今回はserverがスロットごとの所有権と要求設定を持つ位置で実装した。context生成後の登録なので、最初の推論では3グラフの予約が1回残る。以後の開始・終了では `llama_set_sampler` 自体を呼ばない。

## 結果（2026-11-11、検証環境A）

- 実際のページ（MDN の GPUAdapter、同時8本、現行 `baseline-candidate-79a95eddee83` と交互3回）：全体 6.6→6.3秒（-4.5%）、画面内 -5.6%、最初の行 -2.2%。行のずれ・打ち切り・目印の崩れはなし。
- profile-gpu（N15 第1版と併用した版、1回）：行数が変わった直後の decode 1回 29.8→20.4ms（予測の16.5ms には届かない）、queue の待ち 114→51ms、グラフ構築 23→7ms。定常の decode も 3808→3498ms 縮んだ（bind group の作成 66→13ms）。
- 同梱後の通しの試験（`tools/e2e.mjs`）は 26/26 に合格した。CPU・4スレッドで訳す場面も含む。1回目は選択範囲の「訳」アイコンの1件が通らず、回し直して通った（ページ側の機能で、このパッチとは別の経路）。読み込み時のメモリーの増え方は確かめていない。

以下の「予測と採否の指標」「検証と引き継ぎ」は、作った時点の記録。

## 予測と採否の指標

行列積のカーネルと1 stepのGPU時間は変わらず、行数が変わった直後のCPU側固定費を狙う。検証環境Aの実ページでは約28回×約14ms＝約0.4秒、全体約6%の短縮を予測する。定常decodeの時間は現状程度、変化直後のdecodeは約30.7→16.5msが目安となる。

profile-gpuで、最初の推論を除いた行数変化直後のstepについて、次を確認する。

- グラフ構築が4→1回、backend schedulerのreserve用同期が消える。
- queue待ちが約5.7→約1.5ms、GPU以外の固定費が5〜6msとなる。
- 行数が変わったstepの上乗せ約0.4秒が縮み、通常版の実ページでも全体が改善する。
- 訳文・token数・目印・停止位置が基準同士の揺れの範囲に収まる。正常終了に加え、途中取消→再要求でもsamplerを再利用できる。

別のsamplerへ切り替えた際のreserve、行数変更による通常グラフの構築、bind groupの新しい形の作成は残る。初期化直後の登録を終えてから全スロットのsamplerが保持されるまで、余分なreserveが繰り返される場合は実装の失敗として調べる。

## 検証と引き継ぎ

拡張のルートで、`prefill-small-n/README.md` の `$basePatches` にこのフォルダーを追加する。

```powershell
node tools/wllama/build.mjs --variant baseline --patches "$basePatches,tools/wllama/patches/sampling-stable" --plan
# 併用版。profile・profile-gpuは --variant だけ変える。
node tools/wllama/build.mjs --variant baseline --patches "$basePatches,tools/wllama/patches/prefill-small-n,tools/wllama/patches/sampling-stable" --plan
```

`prefill-small-n/verify.mjs` で固定ソースへの単独・併用・計測パッチの実適用を確認した。抽出した適格判定と状態遷移をJSで実行し、9スロット×200回の開始・終了で再登録が発生せず、7種類の対象外設定から通常経路へ戻り、その後の対象要求へ復帰できることを確認した。既存の `node --test tools/unit.test.mjs` は29件通過した。

サンドボックスからDockerへ接続できず、C++/WGSLのビルドとGPU計測は親へ引き継ぐ。単独版の予定IDは `baseline-candidate-eeff57105463`、併用版は `baseline-candidate-5b59879c423c`。profile/profile-gpuも同じ候補hashとなる。これらは計画と適用を確認した段階のIDである。

対象の条件では同じgreedy選択を保つ設計である。実GPUでの出力一致、CPU fallback、読み込み時のメモリー増分はビルド後に確認する。先行登録を行うテキストモデルで、後から対象外の要求を使う場合は、そのスロットの最初の付け替えでreserveを払う。
