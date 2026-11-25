# GPU の選択・デバイスの再試行・検算・報告（adapter）

`0001-select-adapter-retry-device-probe.patch` は ggml-webgpu の GPU の取得を変える。`0002-probe-backend-without-model.patch` は wllama の JS に、モデルなしで推論エンジンを起動して終了する `probeBackend()` を足す（設定画面の「使う GPU」の確認に使う）。固定版は wllama `6647c1e` / llama.cpp `7d7f028`。既存の採用パッチ（commands〜sampling-stable）を当てた後のソースへ当てる。設計と拡張機能側の扱いは [翻訳コア](../../../../docs/03_翻訳コア.md)「GPU の選択と、使えない・止まったときの扱い」。

## 変更

sakutto（`jammaru/sakutto`、MIT、`dc6a500`）の `0007-webgpu-adapter-device-retry.patch` を移植し、報告を加えた。

- アダプター：high-performance・既定・low-power の3通りで求め、この順で shader-f16 を持つ最初のものを使う。使わないものも含めて3通りすべてを報告に残す（ブラウザーが GPU を何個見せているかを確かめるため）。
- デバイス：アダプターの上限 → 2 GiB - 4 に抑えた上限 → 既定の上限 → shader-f16 だけ、の順に求める。失敗しても `GGML_ASSERT` で止めない。
- 検算：workgroup の足し算（16個の和136）と、subgroups を使うときの実際の subgroup_size を読む。足し算が違えば GPU を使わない。subgroup_size が報告の範囲に無い・大きさが分からないときは subgroups を切る（推測した大きさは集計を誤り、訳を崩す）。
- 登録：アダプター・デバイス・検算まで通ったときだけ GPU の数を1にする。以前は後のデバイス取得の失敗で WASM ごと止まった（ggml-org/llama.cpp#23844）。
- モデルなしの起動（0002）：起動時の `llama_backend_init` が `ggml_backend_load_all` で GPU を登録するので、`probeBackend()` は `moduleInit([])`・`wllamaStart`・`wllamaExit` だけで報告を受け取れる（既存の `testBackendOps` と同じ起動の仕方）。モデルの取得も読み込みもしない。
- 報告：結果を `ggml_webgpu: report {JSON}` の1行で出す。拡張機能の `extension/offscreen/gpu.js` が読む。形を変えるときは両方と `tools/unit.test.mjs` を合わせる。

sakutto の計測用の切り替え（`__SAKUTTO_WEBGPU_DEBUG__`）と経過時間の記録は移植していない。

## 検証

- このビルド環境でのビルドと `npm test`（報告の読み取り）。
- 新しいプロファイルの Brave（検証環境B、Radeon 860M）で、設定画面を開くと推論エンジンの起動だけで報告が届き、GPU 名と「ブラウザーが見せている GPU：1つ」が出ることを確かめた（3通りとも同じ GPU、検算は足し算136・subgroup_size 64）。
- 外付けGPUのノートPC（Intel の内蔵GPU＋外付けGPU）で、1.1.10 が外付けGPUで動くことを確かめた（2026-11-25）。Intel の内蔵GPUで計算が止まった原因は、調査用のログ（`GPU`・`GPU失敗`）で確かめる。
