# wllama（同梱）

ブラウザーの中で llama.cpp を動かすライブラリ。拡張機能のOffscreen Document（`offscreen/offscreen.html`）が使う。固定版へ性能改善パッチを重ねた自前ビルド（通常版）を同梱している。

## 現在のファイルと差し替え状態

現在の JS・WASM は、下表の10フォルダー16パッチを固定版へ重ねた通常版（artifactId `baseline-candidate-a5e38c85bf2b`、入力 hash `34c96d93a7acf66bed1fdbbbd947bc8993e660d86efc17bbdf640ccf94bdf9c3`）。

| ファイル | SHA-256 |
| --- | --- |
| `index.js` | `27e54e423c920e8ad9feec1ace4833a4a49afabf741d88ce7727c1a9f892bee7` |
| `wasm/wllama.wasm` | `8dcbdbd74983f3aba0541c7e8375a9f41b1d35ccbe2f6b25a397dd6f9af4c1c1` |

作り直すときは、拡張のフォルダーの1つ上（リポジトリ直下）で次を実行し、出力された成果物の2ファイルを一緒に差し替える。

```powershell
node tools/wllama/build.mjs --variant baseline --patches tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/matmul,tools/wllama/patches/result,tools/wllama/patches/prefill,tools/wllama/patches/matmul-h8,tools/wllama/patches/attn,tools/wllama/patches/prefill-m8,tools/wllama/patches/sampling-stable,tools/wllama/patches/adapter
```

| 項目 | 値 |
| --- | --- |
| 取得元 | npm の `@wllama/wllama` 3.13.0（2026-11-08公開）。<https://github.com/ngxson/wllama> |
| 取得日 | 2026-11-09 |
| tarball の integrity | `sha512-ZvoRdQAn+E+18EvQ9qS036gudiI9rbZRBJgG/qNICPPwrA0Y6SMMdbziz/j7K/0WxcbJlhaRraVIYsnEy732NA==`（npm の値と一致を確認） |
| 現在の2ファイル | `esm/index.js` → `index.js`、`esm/wasm/wllama.wasm` → `wasm/wllama.wasm`（どちらも上表の自前パッチ版。adapter パッチが WebGPU の関数を新しく使い、`probeBackend()` を足すので、JS も配布物と変わる） |
| SHA-256 | `index.js` `27e54e423c920e8ad9feec1ace4833a4a49afabf741d88ce7727c1a9f892bee7`、`wllama.wasm` `8dcbdbd74983f3aba0541c7e8375a9f41b1d35ccbe2f6b25a397dd6f9af4c1c1` |
| ライセンス | MIT License（Copyright (c) Xuan Son Nguyen）。同梱の llama.cpp も MIT License |

## 自前ビルドの固定入力

| 部品 | 版 |
| --- | --- |
| wllama | 3.13.0、commit `6647c1ea3837b2f0205a300c3bf5ff644aaa06bf` |
| llama.cpp | commit `7d7f0287530bc8981690f361d8c1627dbae1c99a` |
| ツールチェーン・依存関係 | `tools/wllama/pins.json` の digest・hash で固定 |
| 作り方・出力 | [ビルドと計測](../../../docs/08_wllamaビルドと計測.md)。成果物と build manifest はリポジトリ外の WORK に出す |

3.13.0 を選んだ理由は、同梱の llama.cpp が PLaMo 3（`plamo3`）とそのトークナイザーの前処理に対応しているため。3.8.1 以前はこの前処理に未対応。

## 採用パッチ

下表は採用した変更の一覧。最終成果物へ適用した順序と各パッチの hash は build manifest で確定する。効果と採否の根拠は [性能の仮説検証](../../../docs/09_性能の仮説検証.md) に集約する。

| ディレクトリ（`tools/wllama/patches/`） | ファイル | 役割 |
| --- | --- | --- |
| commands | `0001-reuse-bind-groups.patch`、`0002-batch-parameter-uploads.patch`、`0003-skip-redundant-queue-waits.patch` | bind group の再利用、引数の一括書き込み、重複するキュー待ちの省略 |
| sampling | `0001-webgpu-argmax-first.patch`、`0002-token-only-output.patch`、`0003-batch-token-read.patch` | argmax の同点規則、条件を満たす翻訳の token-only 出力と一括取得 |
| matmul | `0001-batch-mmvq-columns.patch` | 複数列の decode を MMVQ で計算 |
| result | `0001-drain-results-before-decode.patch` | 完了した結果を次の decode より先に返す |
| prefill | `0001-widen-kquant-register-tiles.patch` | 原文読み込み時の行列積のタイル拡大 |
| matmul-h8 | `0002-share-weights-across-eight-columns.patch`、`0003-limit-wide-mmvq-workgroup.patch` | 8列で重みを共有し、広い MMVQ の workgroup を調整。2パッチを一緒に採用 |
| attn | `0001-skip-masked-prefill-tiles.patch` | 原文読み込み時の attention で、全行が mask されたタイルを読み込み前に飛ばす |
| prefill-m8 | `0001-widen-kquant-thread-tile.patch` | 原文読み込み時の Q4_K/Q6_K の行列積で、1スレッドの受け持ちを 4×8 から 8×8 へ広げる（共有メモリー16KB、GPU名では分けない） |
| sampling-stable | `0001-keep-token-only-slot-samplers.patch` | 温度0の翻訳の sampler を全スロットへ最初に付けて保持し、バッチの開始・終了ごとの計算グラフの取り直し（reserve）をなくす（N1） |
| adapter | `0001-select-adapter-retry-device-probe.patch`、`0002-probe-backend-without-model.patch` | GPU を3通りの `powerPreference` で求めて shader-f16 を持つものを使い、デバイスの取得を再試行し、検算が合わなければ GPU を使わない。結果を拡張機能へ1行で報告する（sakutto 0007 の移植）。モデルなしで推論エンジンを起動して報告を受け取る `probeBackend()` を足す |

H6 の `samplers: ["temperature"]` は offscreen の要求設定として採用する。`attn`（H5）は修正・再計測後の採用版を含む。`cpu`・`cache`・計測用 `profile` もこの採用一覧には含めず、採否は各実験で確定する。

## 要求の適用条件

offscreen は温度0に固定した翻訳へ `backend_sampling: true`・`backend_sampling_token_only: true`・`samplers: ["temperature"]` を渡す。ページ・選択範囲・テキスト翻訳とも同じ生成経路を使う。

配布版3.13.0でも `backend_sampling` と `samplers` は有効。`backend_sampling_token_only` は配布版の schema に無く、未知の項目として無視される。追加項目は JS で JSON へ渡され、固定版の [server schema](https://github.com/ggml-org/llama.cpp/blob/7d7f0287530bc8981690f361d8c1627dbae1c99a/tools/server/server-schema.cpp) が登録した項目だけを評価する。token-only の効果には sampling パッチを含む自前 WASM が必要。

## ライセンスと更新

wllama・llama.cpp、および参照・移植した sakutto の部分は MIT License。出典と各ライセンス本文は [tools/wllama/licenses](../../../tools/wllama/licenses/README.md) にある。元の著作権表示と許諾文を保持する。

更新時は固定入力・順序付きパッチ一覧から通常版を作り、同じ build manifest の `index.js` と `wasm/wllama.wasm` を一緒に差し替える。profile・profile-gpu の計測版を同梱しない。manifest の成果物 hash と実ファイルを照合し、この README と `docs/変更履歴.md` を更新して、通しの試験を変更の区切りの最後に1回行う。

PLaMo Community Licenseの同梱のコピーは、公式pfnet/plamo-3-translate-0.8bのcommit `8b4d42855622093e610ba9b90c2d2b59f8d5c15d` のLICENSE/ja・LICENSE/enから取得（2026-11-15）。
