# WASM SIMD の CPU カーネルを選択する

wllama `6647c1ea3837b2f0205a300c3bf5ff644aaa06bf`（3.13.0）、llama.cpp `7d7f0287530bc8981690f361d8c1627dbae1c99a` 用の候補。wllama checkout のルートで番号順に適用する。

| パッチ | 動作 |
| --- | --- |
| `0001-wasm-simd-cpu-kernels.patch` | upstream docker-compose の通常・compat 両方の CMake 呼出しへ `-DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm32` を追加する。sakutto の0003と同じ2 hunk。 |
| `0002-default-wasm-processor.patch` | 直接 CMake を呼ぶビルド入口でも効くよう、ルート CMakeLists の `project()` より前に同じ変数の既定を置く。 |

現在の `tools/wllama/container-build.mjs` は upstream docker-compose を使わず CMake を直接呼ぶため、0002も必要。CACHE の既定値として追加し、コマンドラインの明示指定は維持する。CMakeLists の変更は現在のビルド計画の configuration hash に含まれ、候補ごとに別の CMake キャッシュが選ばれる。

固定版の `llama.cpp/ggml/src/ggml-cpu/CMakeLists.txt` は、`CMAKE_SYSTEM_PROCESSOR` が `wasm` に一致すると `ggml-cpu/arch/wasm/quants.c` を追加する。Emscripten の `-msimd128` 指定は既存処理を使う。

## オフライン確認

固定版へ cpu 単独、および `commands,sampling,cache,cpu` の順で全パッチの `git apply --check --whitespace=error-all`、適用、`git diff --check` が成功した。ビルド後の object と速度は統率者が確認する。

## ビルド後に確認する手順

PLaMo 拡張のルートから通常ビルドする。現在の `--patches` はカレントディレクトリからのパスを取るため、次のように指定する。

```powershell
node tools/wllama/build.mjs --variant baseline --patches tools/wllama/patches/cpu
```

組合せ比較の指定は `--patches tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/cache,tools/wllama/patches/cpu`。

統率者はビルドのコンテナー内で、対象の CMake build ディレクトリを `BUILD_DIR` に指定して次を実行する。現在の台本では `/cache/configurations/<configurationHash>/build`。upstream の台本では `/source/build`、compat は `/source/build-compat`。

```sh
find "$BUILD_DIR" -type f -path '*/arch/wasm/quants.c.o' -print
test -n "$(find "$BUILD_DIR" -type f -path '*/arch/wasm/quants.c.o' -print -quit)"
grep '^EMSCRIPTEN_SYSTEM_PROCESSOR:STRING=wasm32$' "$BUILD_DIR/CMakeCache.txt"
```

`arch/wasm/quants.c.o` が1件以上見つかり、test と grep が終了コード0になることを確認する。configure ログの `Wasm detected` と、CPU のコンパイル指定 `-msimd128` も確認する。以前の CMake キャッシュを手動流用した場合は、空の build ディレクトリで再構成する。

CPU モード（`n_gpu_layers:0`）で同じモデル・threads・入力・同時本数を固定し、基準版と交互に3組以上測る。prefill、decode、全体時間、出力 token 数、訳と目印の一致を比較する。WebGPU モードも局所確認し、CPU 側へ残る演算の回帰を確認する。

## 出典とライセンス

[sakutto の0003](https://github.com/jammaru/sakutto/blob/73ed0476ed420714131587774b523fae4d61c2c2/scripts/wllama/patches/0003-wasm-simd-cpu-kernels.patch) を移植した。0002は現在のビルド入口に合わせた追加。MIT、Copyright (c) 2026 jammaru。

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
