# H4bの実現性を確認する

H4はprofile-gpuでも行列積401〜425→300msが報告された。次のH4bは、普段のBraveでmatrixのfeature・device要求・小pipelineが通る場合に実装候補とする。このフォルダーは版更新の案と確認台本であり、PLaMoのカーネルやpins本体は変更していない。

## 統率者が回す1行

Pをカレントディレクトリにして実行する。

```powershell
node tools/wllama/patches/prefill-matrix/probe.mjs
```

台本は候補emdawnをTEMPへ取得して公開SHA-256と照合し、ヘッダーとJSのAPI名を確認する。続いて既存の計測用起動経路で、新しい一時プロファイルのBraveを開く。GPU用の実験flagやbackendの変更を加えず、翻訳モデルも読み込まない。

Braveの拡張ページで次を調べ、終了時に今回のBraveだけを閉じる。結果の保存先は `%TEMP%/plamo-matrix-probe-*/probe.json` として表示する。

1. adapter名、features、WGSL features、subgroupの幅、matrix config。
2. `shader-f16`、`subgroups`、`chromium-experimental-subgroup-matrix` をrequiredFeaturesへ渡したdevice作成。サイズ固定の検証ができる場合は `subgroup-size-control` も要求する。
3. configに沿ったf16の小matrixでpipelineを作る。新しいmajorness構文を先に試し、旧boolean構文も診断用に確認する。
4. 全要素1の行列を1回だけ積み、結果がKになるか読み戻す。複数subgroupの出力領域は分け、比較は先頭matrixで行う。

ポートは空きを選ぶ。必要なら `--port 9355` を指定できる。内蔵GPUを見る場合は `--power low-power` を指定し、結果のadapter名がRadeon 860Mか確認する。powerPreferenceはGPU名を直接指定するAPIではない。

```powershell
node tools/wllama/patches/prefill-matrix/probe.mjs --power low-power
```

## 実装へ進むか

| 結果 | 判断 |
| --- | --- |
| `toolchain.status: api-confirmed` と `result.recommendation: implementation-candidate` | API更新と通常Braveでの小matrix実行が成立。prefill matmulに絞った実装へ進む候補 |
| 必須featureがない | 今回の通常起動向け実装はやめ、H4を維持する |
| f16入力・f16結果のconfigがない | 既存matrix shaderをそのまま使う案はやめる。f32累積版は別の費用見積りへ戻す |
| device／shader／pipeline／読取りが失敗 | reason・messages・validationErrorを保存し、実装を保留する |
| package取得だけ失敗 | Braveの確認は続行する。API確認が未完了なので、着手前に候補ZIPを検証する |

小matrixの成功が示すのはAPI・driver・shader経路の成立である。PLaMoの長いK方向のFP16累積品質と速度は、次の実装段階で別に確認する。

## 版と必要な変更

[toolchain-proposal.md](toolchain-proposal.md) に、固定版の不足、確認した更新候補、JSへ渡るfeature名、Dockerfileの差分0行の理由を記載した。[pins.diff](pins.diff) は未適用の案で、`git apply --check` に合格している。更新候補の値は [dawn-candidate.json](dawn-candidate.json) にまとめた。

このsandboxでは候補ZIPの直接取得がEACCESとなった。公開releaseとasset digestはWebで確認したが、更新ZIPと実Braveの確認結果は統率者が実行する台本へ引き継ぐ。固定ZIP・CLI・模擬WebGPU等14条件の試験は完了した。作業・検査資料はTEMPに置く。

## 次段階の費用と品質確認

probeが成立すれば、実装・検証6〜12時間を見込む。RTX 4060のmatmulはH4実測300msに対し、H4bで80〜180msを仮置きする。追加120〜220msを減らせる条件なら検討価値がある。Radeon 860MはWMMAを持つRDNA3.5の実装候補だが、driverと公開config次第であり、同GPUの速度測定はまだない。

既存matrix shaderはFP16累積を使い、NaNについての既知注意がある。着手後は、実モデルのQ4_K/Q6_Kの形状で有限性・誤差を調べる。395／454／512token、長いprompt、端数と非ゼロoffset、混在batchを含める。通常版の訳・マーカー・token列を基準の揺れと比較し、取消・再実行も確認する。非有限値や基準の揺れを超える品質差が出ればFP16累積版を採用せず、f32結果を使う設計を別に評価する。

性能はprofile-gpuでmatmul部分を分けて確認し、通常版の3組以上の前後比較で総時間の5%または試行間変動を超える改善を採用条件にする。SDK・guard・shaderの本実装は、この確認作業では始めない。
