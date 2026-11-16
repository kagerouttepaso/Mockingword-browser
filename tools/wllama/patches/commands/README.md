# WebGPU の命令投入・同期の最適化

wllama `6647c1ea3837b2f0205a300c3bf5ff644aaa06bf`（3.13.0）と llama.cpp `7d7f0287530bc8981690f361d8c1627dbae1c99a` に適用する候補パッチ。通常ビルドでの速度・品質の採否はホスト計測待ち。

## パッチの順序と狙い

番号順に wllama checkout のルートで適用する。対象ファイルはすべて `llama.cpp/ggml/src/ggml-webgpu/ggml-webgpu.cpp`。

| 要素 | パッチ | 変更と期待効果 |
| --- | --- | --- |
| 1 | `0001-reuse-bind-groups.patch` | backend ごとに bind group を保持する。同じ pipeline・buffer・binding・offset・size の組合せでは CreateBindGroup を省く。 |
| 2 | `0002-batch-parameter-uploads.patch` | カーネル引数をホストの arena に置き、submit 直前に1回の WriteBuffer で転送する。 |
| 3 | `0003-skip-redundant-queue-waits.patch` | 新しい投入がない間の重複同期を省く。Map 完了まで待つ専用 get_tensor_async を登録し、共通層の読取り前同期を省く。 |

比較する構成は、基準版、1のみ、1+2、1+2+3。要素3は要素2の一括転送を含む投入経路を追跡するため、1+2の後に適用する。

## キャッシュの寿命と無効化

キーは pipeline handle と、全 buffer entry の binding 番号・buffer handle・offset・size。引数 arena の entry も含む。カーネル引数の値は uniform buffer へ毎回書き直すため、キーへ入れる必要がない。build_multi に渡す entry は固定版の全呼出し箇所で buffer binding であり、sampler・texture・拡張 chain を追加する場合はキーも拡張する。

tensor バッファーを解放する直前に、device 全体で共有する世代を進める。各 backend は次の build_multi で世代を照合し、古いキャッシュを全消去する。これにより解放後に同じ handle 値が再利用されても、古い bind group を返さない。解放されたバッファーの古いキャッシュ参照は次回の build_multi、または backend の破棄時に解放される。buffer.Destroy 自体は従来どおり直ちに呼ぶ。

キャッシュは backend あたり4096件を上限とし、上限到達時の miss で全消去する。全消去前に、その build_multi が取得した bind group はローカル vector が保持する。backend の destructor は arena・pipeline・SET_ROWS 用バッファーの破棄より先にキャッシュを消去する。pipeline は同じ backend の shader library が保持し、固定版には途中で消去する経路がない。

追加の GPU tensor や大きな GPU arena は作らない。上限までの bind group とキーを保持するメモリーは増えるため、長い生成でのメモリーと cache miss による作成の再増加をホストで確認する。

## 引数の転送順序

stage → flush → 同じ queue への Submit → arena.reset の順序を守る。異なるカーネルの引数には既存の slot を使い、offset と binding size は変更しない。前の Submit と次の WriteBuffer の queue 順序により、GPU が前の引数を読む前に上書きすることを防ぐ。GPU profile と SET_ROWS 検査の補助 Submit も同じ submit_commands を通る。

ホスト staging は `slot_stride × slot_count` バイト。既定の64カーネル+余裕10 slot、256バイト境界なら18,944バイト／backend。slot 間の padding も転送するため、呼出し回数が減る一方で転送 bytes は増える。stage の境界と、flush 済みの reset を assert する。

## 同期の完了保証

queue の投入と完了確認は既存の device 共通 recursive mutex で直列化する。全 Submit と、arena 以外の全 WriteBuffer は追跡付きの submit／write_buffer を通す。arena の flush は submit_commands 内で同じ mutex により保護し、直後の Submit が未完了状態を立てる。

未完了状態を消すのは、従来の OnSubmittedWorkDone／WaitAny と成功確認を通った時だけ。初期状態も未完了とし、初回 synchronize は従来どおり確認する。新しい投入があれば次の synchronize は再び待つ。MapAsync と event 完了ではキュー全体の完了状態を変更しない。

専用 get_tensor_async は既存の同期 tensor_get を呼び、対象の CopyBufferToBuffer と MapAsync の成功、ホストへの memcpy、Unmap が済んでから戻る。名前が async でも、戻る時点では対象の出力が利用可能である。読取り後に synchronize が呼ばれれば、キュー全体の完了も確認する。synchronize の無条件 no-op 化は含めていない。

今後 queue.Submit／queue.WriteBuffer を追加する変更は、追跡付き helper を通す。追跡を通らない投入があると、後続 synchronize の完了保証を損なう。同じ backend の graph 実行と tensor 解放を同時に行わない既存の利用契約も維持する。

## 変更した関数・構造体

| 要素 | 関数・構造体 |
| --- | --- |
| 1 | webgpu_global_context_struct の世代、webgpu_context_struct のキャッシュと destructor、ggml_backend_webgpu_build_multi、ggml_backend_webgpu_buffer_free_buffer |
| 2 | webgpu_param_arena の init・stage・flush・reset、ggml_backend_webgpu_submit_commands、ggml_backend_webgpu_build_multi |
| 3 | webgpu_global_context_struct::submit／write_buffer、ggml_backend_webgpu_wait_queue、ggml_backend_webgpu_submit_commands、ggml_backend_webgpu_debug、ggml_backend_webgpu_buffer_memset、ggml_backend_webgpu_set_tensor_async、ggml_backend_webgpu_get_tensor_async（追加）、ggml_backend_webgpu_i、ggml_backend_webgpu_buffer_set_tensor、ggml_backend_webgpu_buffer_set_tensor_n の flush_tensors、ggml_backend_webgpu_buffer_get_tensor、ggml_backend_webgpu_buffer_get_tensor_n |

gpu_sampling 担当とは、get_tensor_async の登録、buffer_get_tensor 系、queue helper の呼出しが重なり得る。MMVQ・shader・scratch の変更は含めていない。

## オフライン確認とホストへの引継ぎ

固定版の独立した wllama／llama.cpp checkout に、各パッチの `git apply --check --whitespace=error-all` と順次適用が成功した。適用後のファイルが生成した最終ソースと一致し、`git diff --check` も通った。固定した Dawn パッケージの header と helper の WriteBuffer／Submit の引数型を照合した。

ソースの最終照合では、tensor buffer 解放と backend 破棄、全 queue 投入、全 arena.reset、GPU profile・SET_ROWS の補助 Submit、共通層の get_tensor_async fallback を追った。コンパイルと実機試験はホストで行う。

既存の `patches/profile/0001-host-timeline.patch` は同じ WebGPU 実装を変更するため、この3パッチの後へそのまま適用すると失敗する。内訳を取得する場合は統合担当が計測パッチを移植する。bindGroup は cache miss の作成、writeBuffer は arena.flush と追跡付き write_buffer、submit は追跡付き submit、queueWait は早期 return 後の実際の待ちを測る位置に置く。

ホストでの作業は次の順とする。build.mjs の --patches 対応後、構成ごとに別のパッチ入力ディレクトリと成果物を使う。

1. 基準版、1のみ、1+2、1+2+3を通常ビルドする。入力 patch hash と成果物 hash を残す。
2. 0.8B・8バッチ・同時4本など同じ設定で基準版と各候補を交互に測る。3組以上で、5%と基準版の試行間変動の大きい方を超える改善、訳の揺れ、`<a1>…</a1>` の保持を確認する。
3. 内訳を測る場合は、要素1で bindGroup 作成回数、要素2で WriteBuffer 回数と bytes、要素3で実際の queueWait 回数を確認する。プロファイルの上乗せを通常速度の採否と分ける。
4. 取消後の再実行、モデル解放・再読込み、異なる長さの入力、長い生成を局所確認する。要素3では書込み→synchronize、graph→synchronize、連続 synchronize、get_tensor_async→出力確認→synchronize を含める。e2e 26項目は統率者の最終統合時に行う。

既存の0.8B profile・第2回では bindGroup 378ms／56,810回、WriteBuffer 89ms／58,578回、queueWait 1,073ms／4,374回。各要素はこの呼出しの反復へ作用する。queueWait には GPU 実行待ちも含まれ、3要素の改善時間を単純に足すことはできない。効果が小さい要素はホスト結果を受けて外すか修正する。

## 出典とライセンス

要素1のキー構築と要素2の staging は、[sakutto の0004](https://github.com/jammaru/sakutto/blob/73ed0476ed420714131587774b523fae4d61c2c2/scripts/wllama/patches/0004-webgpu-reuse-bind-groups.patch) から固定版へ移植した。MIT、Copyright (c) 2026 jammaru。キャッシュを backend ごとに分けた寿命管理・世代による無効化・上限、stage/reset の assert を追加した。要素3は完了保証を残すために作成した実装である。

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
