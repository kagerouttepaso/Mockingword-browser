# 小さいバッチを MMVQ で処理する

wllama `6647c1ea3837b2f0205a300c3bf5ff644aaa06bf`（3.13.0）、llama.cpp `7d7f0287530bc8981690f361d8c1627dbae1c99a` 用の候補パッチ。既定では5〜16行の平坦な行列積を MMVQ のベクトル shader へ流す。統率者が同時4・6・8・16本の速度と訳を測定し、採否を決める。

固定版は4行以下で MMVQ、5行以上で tiled matmul を使う。`0001` は入力全行を一度 q8_1 へ量子化し、4列単位の積と余りの積を同じ dispatch 列に積む。`0002` は Q4_K／Q6_K を最大8列へ広げ、6行は6列、8行は8列、16行は8列を2バッチとして処理する。同じ workgroup 内の列は重みの読取りを共有する。他の量子化型は4列単位を維持する。

対象は `src0`・`src1` の `ne[2]` と `ne[3]` がすべて1の行列積。元の MMVQ が要求する入力 F32、対応する量子化型、AMD／Intel／NVIDIA と dot-product 対応の条件を引き継ぐ。多次元の broadcast は従来の4行上限を使う。非量子化の mat-vec と tiled shader の適用条件も従来どおり。

## 適用と行数上限

このフォルダーのパッチは `0001-batch-mmvq-columns.patch` の1本。`0002`（8列化）は、単独では遅くなったため `0003`（workgroup の調整）と組にして `../matmul-h8/` へ移した（`docs/09`「H8」）。以下の 0002 の説明はその経緯の記録。番号順に wllama checkout のルートで `git apply --check`、`git apply` を行う。0001は固定版へ単独適用でき、0002は0001の後に適用する。commands→sampling→matmul の順と、prefill・attn 等を含む全並びで確認した。

拡張プロジェクトのルートから、次のように上限を指定する。`configure.mjs` はパッチ中の `GGML_WEBGPU_MMVQ_MAX_ROWS` だけを書き換える。パッチ内容の hash が変わるため、既存ビルドの入力識別にも反映される。

```powershell
node tools/wllama/patches/matmul/configure.mjs --max-rows 16
node tools/wllama/build.mjs --patches tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/matmul
```

`--max-rows 4` は5行以上の拡張を止める比較用、`16` は既定、`32`・`64` は短い prefill まで含める比較用。引数は4〜65535の整数を受け付ける。上限を変えた後は新しいパッチから再ビルドする。既存 checkout へ重ねて適用する場合は、その checkout を準備した担当が元のパッチを外してから適用する。

この backend は decode と prefill の用途を識別せず、行数と tensor 形状で選ぶ。既定の16行は decode 相当の小さい行数を対象にするための境界であり、16行以下の prefill にも適用される。用途を厳密に分ける必要がある場合は、呼出元からの情報追加を統率者へ提案する。

## q8 scratch の確保と添字

q8 scratch は出力 tensor の末尾に置く。内積長を `K = src1.ne[0]`、入力行数を `R = src1.ne[1]`、上位次元の積を `B = src1.ne[2] * src1.ne[3]` とする。q8_1 は32要素あたり36バイトなので、実行時に必要な量は `36 * (K / 32) * R * B` バイト。量子化 dispatch は全行を書き、後続の列をまとめた積がこの領域を共有する。

確保側では `L = flat ? GGML_WEBGPU_MMVQ_MAX_ROWS : 4`、`reserved_rows = min(R, L)` とし、`36 * (K / 32) * reserved_rows * B` バイトを予約する。MMVQ が実行される `R <= L` では、実際に量子化する全行が収まる。`R > L` の tiled 経路でも L 行分の予約を残すため、同じ内積長・出力幅・上位次元なら、R を増やしても確保量が減らない。これは固定版に含まれる llama.cpp `1c5ed702c9e540ac14cc8c78100ea3984bc0e227` の意図を維持する。

確保量は従来式の `round_up(ggml_nbytes(dst) + scratch + minStorageBufferOffsetAlignment, 4)` を引き継ぐ。scratch の binding は `round_up(dst_offset + ggml_nbytes(dst), alignment)` から始まり、binding size は4バイト境界へ丸める。既定16行では平坦な長いバッチの scratch 予約が従来の4行分から16行分へ増える。K=1024なら4,608→18,432バイトで、tensor ごとの増分は13,824バイトと alignment 分である。

端数の `first_column` は、入力側では `first_column * (K / 32)` 個の q8_1 ブロック、出力側では `first_column * dst.ne[0]` 個の F32 要素へ変換する。WGSL の MMVQ に `offset_src1` を加え、従来の4行以下ではこの offset を0にする。元入力の binding misalignment を q8 scratch の添字へ流用しない。

## オフライン確認とホストでの受入

2026-11-10、専用 checkout `WORK/opt/webgpu_mmvq` で、単独適用と commands 3本→sampling 3本→matmul の各 `git apply --check --whitespace=error-all`、順次適用、`git diff --check` が成功した。単独適用後の3ファイルは生成元とバイト単位で一致した。`tmp/validate.mjs` で5・6・7・8・9・15・16・17・31・32・63・64行の添字・出力被覆244,062出力と、4〜64行の上限・多次元形状を含む scratch 予約516,096条件を照合した。これは添字と領域計算の検証であり、shader の実行と浮動小数点演算はホストで確かめる。

統率者の次の確認に使う。

1. commands＋sampling を基準とし、matmul を加えた通常ビルドで同時4・6・8・16本を比較する。総時間、最初の表示、decode step の GPU 待ち、メモリーを同じ入力で測る。4本の回帰と、6・8本の悪化解消を確認する。
2. `testBackendOps` 等で1〜9・15・16・17行を含め、端数・出力幅の端・入力と出力の非ゼロ offset・対応量子化型を確認する。多次元 broadcast と非対応型は従来経路も確認する。
3. 実翻訳で token 列、訳、`<a1>…</a1>` の保持、長い生成、取消後の再実行を確認する。5行以上は tiled の浮動小数点積から q8_1＋整数 dot-product へ変わるため、丸めと量子化誤差による token 差を受入判断に含める。
4. `--max-rows 4`・`16`・`32`・`64` を比較し、短い prefill と上限前後の長さを含めて測る。prefill を広げる採否は総時間と品質から決める。上限を上げるほど scratch 予約と重みの再読込みが増え、tiled の方が速くなる境界はGPUに依存する。

ビルド・GPU実行・性能・訳の受入は統率者の担当。今回の sandbox ではソースとオフライン計算まで確認した。

## H8：8行を同じ workgroup で処理する追加候補

0001の8行処理は MMVQ 1 dispatch の中で、4列を処理する workgroup を2組起動する。出力幅 M に対し、1行と4行は `ceil(M/4)`、8行は `2 * ceil(M/4)` workgroups となる。量子化はいずれも別の1 dispatch。5〜7行では4列と端数の MMVQ が各1 dispatch となる。

K量子化の `accumulate_vec_q_dot` は `repack_a`・`get_dm`・`get_scale_min` を列ループの外へ置く。4列内では重みを共有済みで、8行時は2組の workgroup が同じ重みを読む。H8はこの再読込みについて支持される。DRAM転送量はGPUキャッシュにも依存し、ソース上のアクセス数と区別して測る。

行数別の実測値は、pure decode の `tokens` で分けた。`1794239762425` candidate round1の `analysis.gpuTiming.steps` は次のとおり。

| 行数 | step数 | GPU ms/step | MMVQ ms/step | Q4_K ms/dispatch | Q6_K ms/dispatch |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 6 | 4.271 | 2.676 | 0.02867 | 0.07646 |
| 4 | 2 | 8.815 | 6.095 | 0.07851 | 0.13685 |
| 8 | 29 | 15.387 | 11.360 | 0.14388 | 0.26201 |

同じcandidateのround2では、厳密な8行は31 step、GPU15.274ms、MMVQ11.310ms/step。全50 decode stepを含めるとGPU12.925ms、MMVQ9.432ms/stepである。途中で本数が減ったstepを含む平均と、8行だけの平均を分けて比較する。

基準 `1794232524570` は `gpuTiming` を保存していないため、同じ `analyzeGpuEvents` で既存eventsから再構成した。round2の1行52 stepはMMVQ2.766ms/step、Q4_K0.03135・Q6_K0.07421ms/dispatch。4行32 stepはMMVQ6.695ms/step、Q4_K0.08243・Q6_K0.16107ms/dispatchである。抽出は `node tools/wllama/patches/matmul/analyze-h8.mjs PROFILE_DIR` で再実行できる。

0002は既存の `NUM_COLS` に5〜8を渡し、`acc[col][row]` へ最大8列の積を保持する。8行時は workgroup 数とソース上の重み読取りの組数を半分にする。WGSL自体は0001から変更せず、1行の define・pipeline名・workgroup数も維持する。shader選択用viewは上位次元を1とし、実行時のbatch数はuniformへ渡す。これにより16行を8列×2バッチとして処理する場合も、MMVQの選択が保たれる。

8列のpipeline名には `_cols8` が付く。レジスタ内の積は `acc[4][4]` から `acc[8][4]` へ増えるため、レジスタ圧とoccupancyを実測する。列数に比例する dot-product と reduction は残るので、9.9→3.5msはホストで確認する予測値として扱う。1行の速度回帰も同じ計測に含める。

オフラインでは、commands→sampling→matmul＋profile-gpuの10パッチと、commands→sampling→matmul→cpu→cache→result→prefill→attn＋profile-gpuの17パッチについて、各 `git apply --check --whitespace=error-all`、適用、profile計装、`git diff --check` が成功した。1〜16列・出力幅の端数・非ゼロ出力offsetを含む117,096出力の添字と被覆を照合した。

拡張プロジェクトのルートで、次の1行が profile-gpu のビルドと同時8本の比較を行う。基準と候補に同じ completion-extra を指定し、H8の差を測る。

```powershell
$h8Groups='tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/matmul'; $h8Id=(node tools/wllama/build.mjs --variant profile-gpu --patches $h8Groups --plan | ConvertFrom-Json).artifactId; node tools/wllama/build.mjs --variant profile-gpu --patches $h8Groups; if ($LASTEXITCODE -eq 0) { node tools/profile.mjs --models 0.8B --reference profile-gpu-candidate-3b743a5866c6 --candidate $h8Id --parallel 8 --completion-extra '@tools/wllama/patches/matmul/h8-completion.json' --reference-completion-extra '@tools/wllama/patches/matmul/h8-completion.json' }
```

## 出典とライセンス

4列単位の分割、tensor view、dispatch 引数、端数の WGSL offset は [sakutto の0004](https://github.com/jammaru/sakutto/blob/73ed0476ed420714131587774b523fae4d61c2c2/scripts/wllama/patches/0004-webgpu-reuse-bind-groups.patch) から移植した。MIT、Copyright (c) 2026 jammaru。固定版の shader context を再利用し、行数上限・確保側の同じ上限と単調性・設定用引数を追加した。

借用部分の MIT 本文：

```text
MIT License

Copyright (c) 2026 jammaru

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
