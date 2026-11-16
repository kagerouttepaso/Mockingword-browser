# Q4_K/Q6_Kのregister tileを広げる試験

`0001-widen-kquant-register-tiles.patch` は固定版 wllama `6647c1e`、llama.cpp `7d7f028` の `get_mul_mat_fast_pipeline()` で、Q4_K/Q6_Kの出力タイルを32×32→32×64、K方向を32→64へ広げる。64threadのworkgroupを保ち、重みのタイル再読込みとKループのbarrierを減らす。commands→sampling→matmulの上へ適用し、attnとも併用できる。

## H4の判断と予測

固定版はEmscriptenでsubgroup matrixの検出・要求を除外している（`ggml-webgpu.cpp:4558〜4594,4603〜4608`）。`ggml-webgpu-shader-lib.hpp:2286` の選択条件はcapabilityそのものであり、Braveのfeaturesだけではmatrixへ切り替わらない。今回の採用候補はreg_tileの調整とする。matrixを使うにはemdawnとJS公開APIへの接続が必要で、別の変更として統率者へ提案する。

395＋66tokenのround2で、Q4_Kは94回346.554ms、Q6_Kは30回77.857ms、合計424.411ms。タイル調整により合計265〜354ms、約1.2〜1.6倍を予測する。prefill＋mixedのhost合計684.640msは約525〜615ms、8バッチ1.79秒は約1.63〜1.72秒を目安にする。GPUのレジスター圧力と共有メモリー占有が増えるため、この幅は試験で採否する仮説である。

出力列395なら重みタイルの読込み回数は13→7、66なら3→2。Kが2048ならKループは64→32回、workgroup当たりのbarrierは128→64回となる。積和自体の回数とK方向の計算順は保つ。共有メモリーは4096→12288バイト、thread当たりのaccumulatorは16→32要素になる。

選択条件はQ4_K/Q6_K、subgroup matrix無効、deviceの共有メモリー上限12288バイト以上。型とdevice固定値だけで決めるため既存pipeline cache keyへ整合する。`ggml-webgpu.cpp` のmatmulコンテキストへ上限値を渡す1行も含む。新しいpipeline名は `mul_mat_reg_tile_q4_K_n8k64_f32` と `mul_mat_reg_tile_q6_K_n8k64_f32`。

MMVQ、float、他の量子化型、mul_mat_id、matrix版は既存の選択を使う。matmulパッチの上限以下のdecodeはMMVQへ進むため、純decodeのGPU時間は概ね同じになる予測である。9行以上などMMVQを越える短いprefillは今回のタイルも使うため、9・17・33・65行の端数と速度を確認する。

## 実測とGPU時間の比較

通常版の `baseline-candidate-921dff0231f1` に対し、prefill追加の `baseline-candidate-13ea768c8bf4` は8バッチ1.706／1.670→1.575秒、5.7〜7.7%短縮した。最初の表示は1.41→1.28秒。訳の差は基準でも出る揺れで、速度判定はtrueと報告された。H4は採用候補であり、GPUの行列積時間の確認を次に行う。

Pをcwdにして次の1行を実行する。

```powershell
node tools/wllama/patches/attn/run-experiment.mjs prefill
```

台本はcommands＋sampling＋matmul（0001のみ）＋resultを基準に、profile-gpuの基準版とprefill追加版をbuildし、profile.mjsを呼ぶ。比較は同時8本、cache_prompt:false、quality-replays 2で固定する。`--plan` でビルドせず次を確認できる。

- 通常版に換算した基準：`baseline-candidate-921dff0231f1`
- GPU基準：`profile-gpu-candidate-921dff0231f1`
- GPU候補：`profile-gpu-candidate-13ea768c8bf4`

出力ケースはTEMPへ生成する。新しいpipelineは `mul_mat_reg_tile_q4_K_n8k64_f32`／`q6_K_n8k64_f32`。行列積424.411ms→265〜354msの予測を、同じtoken数・batch構成のstepで照合する。batch構成が変わった場合は、GPU時間／prefill token数と総時間も併記する。

```powershell
node tools/wllama/patches/attn/analyze-profile.mjs <profile出力ディレクトリ>
```

適用・添字の検査は `../attn/verify.mjs` を使い、結果はTEMPへ保存する。subgroup matrixをWASMで使う次案の費用・効果・利用条件は [H4bの評価](SUBGROUP_MATRIX.md) にまとめた。
