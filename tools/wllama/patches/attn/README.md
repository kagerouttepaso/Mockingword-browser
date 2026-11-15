# 全maskのprefill attentionを省く改訂版

`0001-skip-masked-prefill-tiles.patch` を差し替えた。新しいmask分類は固定アドレスのworkgroup `atomic<u32>` を使う。commands→sampling→matmul（0001）→resultの上へ適用する。matmul-h8は含めない。

## H5の確定原因と修正

native-logで取得したBraveの診断は、f32型の定数評価で生成された負の無限大を拒否するshader-creation errorだった。失敗したpipelineは `flash_attn_tile_mask_skip_...` で、その後のdevice未捕捉エラーがggml_abortへ進んだ。失敗原因を定数のf32へのbitcastと確定し、前回のuniformity／可変添字ポインターという推定を訂正する。

`flash_attn_decls.tmpl:104` のmaskは `array<f16>`。今回のパッチは読み出したf16の生ビットをu32に詰め、下位16ビットを `0xfc00u` と比較する。浮動小数点の無限大定数も、mask値のf32変換も作らない。

```wgsl
let mask_bits = bitcast<u32>(vec2<f16>(mask[mask_idx], f16(0.0))) & 0xffffu;
lane_visible = lane_visible || mask_bits != 0xfc00u;
```

`vec2<f16>` とu32はともに32bitで、このbitcastは[WGSL仕様](https://www.w3.org/TR/WGSL/#bitcast-builtin)に定義されている。浮動小数点const-expressionの無限大が生成エラーになる規則は[15.7.2](https://www.w3.org/TR/WGSL/#floating-point-evaluation)に対応する。

同梱の `probe-webgpu.js` にあった同じ式も修正した。全patchフォルダーのコード30ファイルを調べ、正負の無限大ビットを定数f32へbitcastする式は0件となった。JavaScript参照モデルのInfinityはCPU側の試験入力として維持する。

mask分類は固定アドレスのworkgroup atomic<u32>へ集約し、uniformなu32の結果だけで省略を分岐する。追加4バイトはタイル選択とmatrixからのfallbackの両方で予約する。有限maskとALiBiは従来経路を通す。pipeline名の `_mask_skip` も維持する。

## 統率者の再検証

Pをcwdにして実行する。基準と候補の両方をprofile-gpuでbuildし、同時8本・cache_prompt:false・quality-replays 2で比較する。

```powershell
node tools/wllama/patches/attn/run-experiment.mjs attn
```

`--plan` ではビルドせずIDと入力hashを確認する。現行基準は `profile-gpu-candidate-921dff0231f1`、改訂候補は `profile-gpu-candidate-54e3803a72c6`。case JSONはTEMPへ生成し、今回生成した成果物のディレクトリをprofile.mjsへ渡す。

最初にモデル読込みとprefillが完了するか確認する。失敗時は一時拡張で `suppressNativeLog:false` とし、WebGPUの検証診断本文を保存する。これは統率者が扱う一時拡張への差分案である。

`probe-webgpu.js` をBraveのDevToolsで実行すると、adapterのfeatures・matrix configに加え、新しいmask分類だけのWGSLとpipelineを作成し、診断本文をJSONへ出す。probeは追加分類の検証に使い、実attention全体の確認は候補WASMで行う。

旧計測round2のtile attentionは141ms／32回。KVタイルを75〜90%省ける条件では25〜55msを狙う。改訂版ではatomicの競合と同期が加わるため、初版の予測を採用の証拠にはしない。速度は同じtoken数・batch構成で比較し、訳と目印も照合する。

```powershell
node tools/wllama/patches/attn/analyze-profile.mjs <profile出力ディレクトリ>
```

## 適用・参照試験

`verify.mjs <wllama checkout> <llama.cpp checkout>` は元checkoutを読み取り、TEMP内のコピーへcommands→sampling→matmul→result→prefill→attn＋profileを適用する。12件の適用確認、profile計装、mask走査24,384条件、online softmax参照1,344条件、f16全65,536ビット列の負の無限大判定、matmul端数16形状に合格した。C++／WGSLのコンパイルは統率者の実機確認へ渡す。

検証資料の保存先は実行時に表示する。初版の検査JSONと生成caseもTEMPへ退避した。以後の検証・計測caseはTEMPへ出す。

## H4・H6の実測を引き継ぐ

H4は通常版の8まとまり1.706／1.670→1.575秒で、5%の判定幅を超えた採用候補。GPUの行列積時間はprefillの台本で別に確かめる。H6のgreedy指定は1.705→1.644秒、3.4%で判定幅内のため、速度だけでの採用は保留する。両方の訳の差は基準でも発生する揺れと報告されている。
