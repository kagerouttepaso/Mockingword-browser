# H4b：subgroup matrixをWASMで使う判断

現時点では、両GPUでfeatureと対応configを採る30〜60分の確認を推奨する。RTX 4060で条件を満たせば、実装・検証6〜12時間を投じる価値がある。通常のBraveでfeatureが出ず、実験用flagやbackend変更だけで動く場合は、製品の既定経路への採用を保留する。H4のregister tile改善は維持する。

## 必要な変更

現在の固定emdawnは `v20260317.182325`。保存済みZIPのSHAはpinsと一致し、`webgpu.h` にはmatrix featureのenumとconfig構造体がない。ggmlのEmscripten除外を外すだけではビルドできない。

1. `pins.json` のemdawnを、matrix APIをEmscriptenへ公開する版へ更新し、ZIPのSHAを固定する。少なくとも `v20260818.211311` での公開実績がある。ONNX Runtimeが同じWASM除外を外した[一次資料](https://github.com/microsoft/onnxruntime/pull/32269)を根拠とする。
2. `ggml-webgpu.cpp:4558〜4608` のmatrix関連の検出・config取得・device要求をEmscriptenにも通す。native専用 `ImplicitDeviceSynchronization` のguardは維持する。新emdawnがJSとの接続を担うため、独自のJS bridgeを先に増やす必要はない。
3. JSの `adapter.features` に `chromium-experimental-subgroup-matrix`、`subgroups`、`shader-f16` があることを確認する。`adapter.info.subgroupMatrixConfigs` から型・M/N/K・subgroupサイズを選び、対応するrequiredFeaturesをdeviceへ要求する。
4. `mul_mat_subgroup_matrix.wgsl:144,154,184` と `flash_attn.wgsl` のload/storeを、新版のmajorness template構文へ直す。旧版のboolean `col_major` overloadは上記emdawn更新の時点で廃止されている。既存shaderをそのまま通す更新にはしない。
5. 初回はprefillのQ4_K/Q6_Kのmatmulへ範囲を絞り、attentionは現行経路で比較する。現在のcapability一括有効化はattentionの選択まで変えるので、H4bの効果を分けて計測できる選択条件が要る。

追加機能名とconfigの公開形は[GPUWeb提案](https://github.com/gpuweb/gpuweb/blob/main/proposals/subgroup-matrix.md)で確認した。実験機能の公開flagはBraveの版・backendで異なるため、まず普段の起動条件で `probe-webgpu.js` を実行する。

## RTX 4060とRadeon 860Mの可否

現行の固定WASMスタックでは両方とも利用不可。これはGPUの能力と別に、API欠落とコンパイル除外で決まる。更新後のハードウェア上の見込みは次のとおり。

| GPU | ハードウェア上の見込み | WebGPUで使える条件 |
| --- | --- | --- |
| RTX 4060 | AdaのTensor Coreがあり、第一対象に適する | 必須feature、f16入力・f16結果のconfig、試験pipeline作成が通ること。Vulkanではcooperative matrix等のdriver機能が必要 |
| Radeon 860M（RDNA3.5） | WMMAの16×16×16、f16入力・f16結果命令があるため実装候補 | 必須featureとconfigを実機で確認する。configのsubgroupサイズが32固定なら、それに合わせるshaderとdevice機能も確認する |

RTX 4060のTensor Coreは[NVIDIA仕様](https://www.nvidia.com/en-us/geforce/graphics-cards/40-series/rtx-4060-4060ti/)、RDNA3.5のWMMA命令は[AMD ISA](https://www.amd.com/content/dam/amd/en/documents/radeon-tech-docs/instruction-set-architectures/rdna35_instruction_set_architecture.pdf)に対応する。GPU名だけでブラウザーの利用可否は決めない。

Dawnの[Vulkan実装](https://dawn.googlesource.com/dawn/+/refs/heads/main/src/dawn/native/vulkan/PhysicalDeviceVk.cpp)はcooperative matrix、device-scope memory model、full subgroup、subgroup-size controlを照合する。[現行D3D12実装](https://github.com/google/dawn/blob/main/src/dawn/native/d3d12/PhysicalDeviceD3D12.cpp)にはSM6.10とlinear algebra対応を要する実装もある。古い設計資料のD3D未対応という記述だけで全Brave版を不可とは判定しない。Dawnのmainにある機能が手元のBraveに入っているかは、probe結果で決める。

## 時間の予測

次は実装前の見積りである。同じ約454prefill token、約0.73TFLOP相当のmatmul部分を比較する。Tensor Core等の理論ピークを、そのままカーネルの実効性能には使わない。量子化解除、タイルの端数、共有メモリーの処理を含む。

| GPU | 仮定する実効性能 | matmul部分の予測 |
| --- | --- | --- |
| RTX 4060 | 約4〜9TFLOPS | 80〜180ms。旧reg_tile実測424msに対して約2.4〜5.3倍 |
| Radeon 860M | 約1.2〜3.3TFLOPS | 220〜600ms。同GPUの基準測定がないため倍率は未定 |

RTXではH4適用後のmatmulが265〜354msという従来予測に対し、追加で概ね0.1〜0.25秒を削る余地がある。この比較はH4のprofile-gpu実測で更新する。860Mはメモリー共有・電力枠・driverの影響が大きく、最初の1回のprofile-gpuを見積りの更新に使う。

## 費用と採否

| 工程 | 見積り |
| --- | --- |
| 両GPUのfeature/configと小pipelineの確認 | 30〜60分 |
| emdawn更新、guard、shader構文、matmulの選択条件 | 2〜4時間 |
| 量子化型・端数・offset・fallbackのGPU照合 | 2〜3時間 |
| 両GPUの性能、token列、訳とマーカー、通常版の比較 | 2〜4時間 |

初回は全体6〜12時間、環境差を含めて1〜2日を見込む。driverやBraveの実験機能で止まったら、実装前の段階で保留できる。

主な品質リスクはFP16累積である。既存shaderの127行は `subgroup_matrix_result<f16,...>` を使い、15行にはFP16累積によるNaNの既知注意もある。現行reg_tileのf32累積から変わるため、有限性・token列・訳の照合を必須にする。f32結果のconfigしかない場合は、累積型と共有領域も変える別の設計として費用を見直す。

今回の推奨は「feature/config確認へ進む」。RTXで利用条件と品質を満たす見込みが立てば実装へ進む。必要なpins・ビルド経路の変更は担当範囲外なので、統率者へ提案し、このリクエストでは実装しない。
