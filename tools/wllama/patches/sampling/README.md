# 翻訳用 backend sampling の token 読み戻し

固定版 wllama `6647c1ea3837b2f0205a300c3bf5ff644aaa06bf`、llama.cpp `7d7f0287530bc8981690f361d8c1627dbae1c99a` に適用する試験用パッチ。翻訳要求で GPU が選んだ token ID だけを読み、複数 sequence の取得を1回の Map にまとめる。sampling chain の順序と演算は保つ。

パッチは固定版への適用確認とオフライン検査を終えた段階で、採用判断にはホストでのビルド・計測が必要である。`extension` と配布物は変更していない。

## パッチと適用

ビルド用 wllama checkout のルートから、次の順で適用する。各パッチのパスは `llama.cpp/` を含む。`build`、`profile` の既存パッチとも併用できる。

| ファイル | 変更と目的 |
| --- | --- |
| `0001-webgpu-argmax-first.patch` | WebGPU argmax の同点選択を先頭候補へそろえ、`-1e9` の初期下限を除去する。scalar／vec4 とも無限値・NaN の参照規則を含む。 |
| `0002-token-only-output.patch` | completion に `backend_sampling_token_only` を追加する。適格な chain の末尾で読み戻し対象から logits／probs／candidates を外し、CPU が候補配列を構築する前に token ID を返す。 |
| `0003-batch-token-read.patch` | 同じ backend にある token-only の全出力行を `ggml_backend_tensor_get_n()` へ渡す。既存 WebGPU の staging 一括コピーを使い、Map を1回にする。 |

```powershell
git apply --check <samplingディレクトリ>/0001-webgpu-argmax-first.patch
git apply <samplingディレクトリ>/0001-webgpu-argmax-first.patch
git apply --check <samplingディレクトリ>/0002-token-only-output.patch
git apply <samplingディレクトリ>/0002-token-only-output.patch
git apply --check <samplingディレクトリ>/0003-batch-token-read.patch
git apply <samplingディレクトリ>/0003-batch-token-read.patch
```

`build.mjs --patches` の入口が統合されたら、このディレクトリを追加パッチとして指定し、通常版と profile 版をそれぞれビルドする。正確な引数形式はビルド担当の実装に合わせる。

## 最初に行う既存 flag の試行

現行ビルドのまま、WORK 内の一時拡張コピーにある `offscreen/offscreen.js` の `createCompletion` 引数へ1行を加える。内訳測定には既存の profile 版を使い、この段階では追加パッチのビルドを使わない。

```diff
         temperature: 0,
+        backend_sampling: true,
         stop: message.stop,
```

wllama の `createCompletionImpl()` は追加項目を `JSON.stringify({ ...options, ...customOpt })` へ渡す。固定版の server schema は `backend_sampling` を受け取る。

token ID 列の開発用ログには、比較する両方の要求へ `verbose: true` と `return_tokens: true` を渡せる。OAI completion の応答は `__verbose.tokens` に native の token ID を含める。partial と final の token 列を重複計上せずに保存し、通常版の速度判定では開発用ログを無効に戻す。

現行の `build_sampling()` は sampled token 以外に sampled logits／probs／candidates も出力として保持し、`decode()` が各行を個別取得する。さらに `common_sampler_sample()` は、GPU 選択済み token の確認より先に `set_logits()` を呼ぶ。これが今回省く経路である。

既定 chain がすべて offload された場合、temperature 0 の backend sampler は候補を1件へ縮める。そのため flag だけでも全語彙の取得が消え、通常は token・logit・candidate の計12バイト／行となる見込みである。未対応 sampler で backend prefix が途中までになった場合は、残る候補の取得量が増える。実測は raw logits カウンターに加え、全 `tensorRead` の回数・時間、`hostCopy.bytes` と `mapWait` 回数を確認する。

## パッチ版の適用条件

追加パッチをビルドした候補版では、同じ一時コピーに次の2項目を渡す。

```javascript
temperature: 0,
backend_sampling: true,
backend_sampling_token_only: true,
```

token-only の指定は既定 false。server は通常の completion かつ投機的デコード無効の場合に限って指定を通す。`common_sampler_init()` は次の条件を照合し、成立しなければ指定を false に戻す。

- `n_probs == 0`、temperature 0、dynamic temperature range 0、mirostat 無効。
- grammar・grammar trigger・preserved token・ユーザー logit bias・ignore_eos・reasoning budget／control が無効。
- repeat penalty 1、frequency／presence penalty 0、DRY／XTC 0、typical_p 1、adaptive sampling と top_n_sigma が無効。
- sampler は既定 chain にある種類だけで、最後が temperature。

top-k／top-p／min-p は従来どおり計算する。モデルが持つ suppress token の bias も既存の chain が処理する。EOG bias の事前計算リストは、`ignore_eos` により有効化された場合にだけ除外条件となる。

末尾に加える `token-only-output` は、backend chain が最後まで実行されて token が確定した場合に出力を絞る。CPU では既存の候補配列をそのまま通す。未対応 sampler で offload が途中までになった要求は、既存の候補読み戻しと CPU sampling を使う。token-only 時に `common_sampler_get_candidates()` が返す配列は空である。

一括取得は、ubatch の全出力行が token-only で同じ backend にある場合だけ使う。CPU fallback・確率出力・複数 backend の混在は従来の取得へ戻す。取得先の offset は logits の行順と `n_outputs_prev` を使うため、sequence ID が連続していない場合や ubatch を分割した場合も既存の出力対応を保つ。

## 同期と変更範囲

`copy_token_only_rows()` は `ggml_backend_synchronize(backend)` で完了を待ち、その後に同期 API の `ggml_backend_tensor_get_n()` を呼ぶ。これは WebGPU の `get_tensor_async == NULL` 時に従来の個別取得が満たしていた完了保証に対応する。WebGPU 実装は複数 tensor を staging buffer にコピーしてから1回だけ Map する。

既存の ggml 公開 API と WebGPU の同期・Map・get_tensor 実装、graph の構造を利用する。JS の chunk・abort・runaway 打ち切りは、1回の decode が返す token を次の既存処理へ渡す流れを保つ。

| ファイル | 触れた関数・定義 |
| --- | --- |
| `common/common.h` | `common_params_sampling` の追加項目 |
| `common/sampling.cpp` | `token_only_*` の補助関数、`common_sampler_init()`、`common_sampler_sample()` |
| `tools/server/server-schema.cpp` | `server_schema::make_llama_cmpl_schema()` の設定登録 |
| `tools/server/server-context.cpp` | `launch_slot_with_task()` の sampler 初期化前の適用制限 |
| `tools/server/server-task.cpp` | `task_params::to_json()` の両出力形式 |
| `src/llama-context.cpp` | `copy_token_only_rows()`、`llama_context::decode()` |
| `ggml/.../argmax.wgsl` | `first_max()`、`main()` |

## 検証とホストでの計測

オフラインでは、固定版へ3パッチの `git apply --check` と `git diff --check` を確認する。profile パッチの前後両順でも適用を照合する。

採用時に、実 WGSL の `first_max()` 本体を読み、CPU greedy の逐次走査と684通りを比較した（検査の台本は常設していない）。候補数1〜107,520と workgroup 32／64／128／256を scalar／vec4 で照合した。入力は同点、`-1e9` 未満、±Infinity、NaN、±0を含めた。GPU コンパイルと実機の浮動小数点の動作は、ホストの検査対象に残る。

ホストでは次の順に比較する。

1. 同じ現行 profile 版の flag 無効／`backend_sampling: true` を比較する。decode の raw logits 行数・バイト数、全 tensorRead の回数・時間、hostCopy.bytes、Map 回数と待ち、CPU sampling 時間、生成 token ID 列を保存する。
2. パッチ版で token-only 無効／有効を比較する。複数 sequence の純粋な decode では sampling の取得が `4 × 出力行数` バイト、Map 1回／ubatch になることを確認する。2行なら8バイト、4行なら16バイト。KV 等の別用途の取得は用途ごとに照合する。
3. 1・2・4本の同時生成、片方の完了後、途中取消と再要求、長い prefill による ubatch 分割、モデル切替を確認する。`n_probs > 0`、温度が正、penalty／grammar／logit bias 有効の要求では token-only が無効になることも確認する。
4. 両モデルで token 列、訳、`<a1>…</a1>`、逐次表示、runaway／行数の打ち切りを基準版と比較する。中間段階の確認はこの範囲とし、最後の e2e 26項目は統率者が実施する。
5. profile なしの通常版を固定設定で交互比較する。5%と試行間変動の大きい方を超える改善が3組以上で再現し、訳の差が基準版の揺れに収まることを採用条件とする。

## 期待効果と採否の注意

全語彙107,520の F32 logits は1行430,080バイトである。flag と追加パッチが対象経路へ入れば、sampling の読み戻しは4バイト／行まで減る。複数行でも WebGPU の Map は1回にまとまり、CPU は全候補の構築・sampling を省略できる。

出力が R 行で、既定 chain が完全に GPU へ offload された場合の見込みは次のとおり。既存の profile では転送量を `hostCopy.bytes` で読む。token の memcpy 自体は行ごとに残り、最終段階でも hostCopy の回数は R となる。

| 経路 | sampling の読み戻し量 | sampling による Map 回数 |
| --- | ---: | ---: |
| 現行 CPU sampling | 430,080 × R バイト | 通常1 |
| 既存 backend_sampling のみ | 通常12 × R バイト | 通常3 × R |
| 0002まで適用した token-only | 4 × R バイト | R |
| 0003まで適用した token-only | 4 × R バイト | 1 |

既存の0.8B計測には decode の tensorRead 約560ms、sampling 約301msがある。この二値は候補を絞る材料で、時間短縮の予測値として足し合わせるには GPU sampling と残る同期費用の実測が必要である。GPU 内の top-k／top-p 等の時間も測り、追加パッチと flag の寄与を分けて判断する。

WebGPU argmax は、CPU greedy と同じく同点で候補配列の先頭を選ぶ。top-k／top-p などが作る候補順序や浮動小数点丸めには backend 間の差が残り得るため、chain 全体の token 列をホストで照合する。基準版の揺れを超える差があれば、訳・目印・速度を添えて統率者へ返す。

候補配列を直接使う新しい呼出元や、投機的デコードへ token-only を広げる場合は、適用条件と契約の再検討が必要である。今回の採用範囲は、明示指定した通常の翻訳 completion に限る。

CPU に残る費用として、`output_reorder()` は出力行の並べ替えが発生すると、sampling の count が0でも全語彙の logits／probs／candidates を swap する。大きなホスト用バッファの確保も従来どおりである。今回の読み戻し削減を測った後、並べ替えを伴う step の sampling 時間が支配的なら、次の候補として有効件数に沿った処理を評価する。
