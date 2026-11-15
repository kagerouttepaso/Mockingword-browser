# emdawnとビルド設定の変更案

更新したemdawnを使えば、既存のC++ API→WASM内のemdawn JS→ブラウザーのrequestDeviceという経路を使える。既存bridgeを使い、固定版に欠けているmatrixのenum・config構造体を更新版で補う案である。

## pins.jsonの案

| 項目 | 固定版 | 更新候補 |
| --- | --- | --- |
| Dawn | v20260317.182325 | v20260818.211311 |
| SHA-256 | 8dcae86c630d76b6794b271c6572becba36f4237d132bee121a56638c3d76575 | ff3e535c5facf4d820e6c393e06e26493ebd8d35649f972899e6048250efce29 |
| Emscripten | 4.0.20を保持 | まず4.0.20を保持してビルド確認する案 |

候補ZIPのURLとSHAは[公開asset一覧](https://github.com/google/dawn/releases/expanded_assets/v20260818.211311)で確認した。[release説明](https://github.com/google/dawn/releases/tag/v20260818.211311)はremoteportをEmscripten 4.0.10以降向けとし、5.0.6での試験を記載している。現在の4.0.20はこの下限を満たすため、最小案では保持し、小ビルドで互換性を確認する。5.0.6は不整合が出た場合の更新候補とする。

[pins.diff](pins.diff) はDawnのtag・URL・SHAだけを変える未適用の案。6〜12時間の実装に進む判断後、候補ZIPのAPI検査と小さいビルド確認を先に行う。4.0.20でportの不整合が出た場合は、releaseの試験版5.0.6へSDKのtag・image digestを更新する別案を作る。

## Dockerfileの差分案

必要な差分は0行である。現行Dockerfileは `ARG EMSDK_IMAGE` と `ARG NODE_IMAGE` を受け、build.mjsがpinsのdigestを `--build-arg` へ渡す。DawnのZIPはcontainer-build.mjsがpinsのSHAで照合・展開し、CMakeへ渡す。Dawnの版はDockerfileへ埋め込まれていない。

SDKの更新が必要になっても、版を管理する場所はpins.jsonであり、同じDockerfileを使う。今回の案ではDockerfile本体を編集していない。

## APIとwllama内の位置

| C++側 | JS／ブラウザー側 |
| --- | --- |
| `FeatureName::ChromiumExperimentalSubgroupMatrix` | `chromium-experimental-subgroup-matrix` |
| `FeatureName::Subgroups` | `subgroups` |
| `FeatureName::ShaderF16` | `shader-f16` |
| `AdapterPropertiesSubgroupMatrixConfigs` をAdapterInfoへchain | `adapter.info.subgroupMatrixConfigs` |
| DeviceDescriptorのrequiredFeatures | `adapter.requestDevice({ requiredFeatures: [...] })` |

固定ZIPの `webgpu/src/library_webgpu.js:800〜805` はC++のenum配列を `WebGPU.FeatureName[feature]` でJSのrequiredFeaturesへ変換する。wllamaのloadModelオプションへ独自のfeature配列を足す構成にはしない。WebGPU deviceを作るのは `ggml-webgpu.cpp:4553` 以降であり、emdawnのJSはWASM workerで実行される。

更新候補でmatrix APIがEmscriptenへ公開されることは、[ONNX Runtimeの同種更新](https://github.com/microsoft/onnxruntime/pull/32269)でも確認できる。台本は候補ZIPをSHAで検証した後、C/C++ headerのenum・config・chain、JSのfeature名・configプロパティ・requiredFeaturesを検査する。

## 本実装で残る変更

- `ggml-webgpu.cpp` のmatrix検出・config取得・要求をEmscriptenへ通す。native専用の同期featureは除外guardを維持する。
- `mul_mat_subgroup_matrix.wgsl` のload/storeを更新候補のmajorness構文へ合わせる。probeは新旧構文のどちらが実ブラウザーで通るかを保存する。
- 最初はprefillのQ4_K/Q6_Kだけを選ぶ。capabilityを一括で有効にしてattentionまで変えることを避け、H4bの寄与を分ける。
- `subgroup-size-control` と明示サイズを必要とするconfigでは、そのAPI要求・shader属性も合わせる。probeのpinned成功だけの場合は、この追加条件を費用へ含める。

これらは着手後の変更範囲を示す案であり、本フォルダーから自動適用・ビルドは行わない。
