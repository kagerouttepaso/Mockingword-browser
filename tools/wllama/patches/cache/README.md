# 翻訳要求の状態保存と完了時の KV 保持を減らす

wllama `6647c1ea3837b2f0205a300c3bf5ff644aaa06bf`（3.13.0）、llama.cpp `7d7f0287530bc8981690f361d8c1627dbae1c99a` 用の候補。wllama checkout のルートで番号順に適用する。

| パッチ | 動作 |
| --- | --- |
| `0001-disable-state-cache.patch` | wllama の C++ 読込み設定で `cache_ram_mib=0`、`n_ctx_checkpoints=0` を既定にする。 |
| `0002-release-uncached-slots.patch` | 要求の `cache_prompt=false` のとき、release で `prompt_clear()` を呼ぶ。既存の child・stateless・audio_stream・realtime・TTS の処理を維持する。 |

公開 `loadModel()` は `n_ctx_checkpoints` を C++ へ転送しないため、C++ 側の既定を変更した。内部 GLUE で明示された checkpoint 数は既存処理で上書きできる。cache RAM の無効化は、この候補を適用した wllama の全モデル読込みに作用する。

`prompt_clear()` は `mem.seq_rm(id, -1, -1)` と prompt の消去を行う。スロットは従来どおり idle に戻し、完了した要求の KV セルを再利用可能にする。モデル全体の KV バッファーの確保量は維持される。

## 拡張側で採用する設定

現行の `extension/offscreen/offscreen.js` は `cache_prompt` を指定せず、server の既定は true。完了時の KV 解放を使う場合は、統率者が `createCompletion()` の設定へ次を追加する。拡張の変更はこの担当の範囲外。

```js
cache_prompt: false,
```

これにより繰返し要求の prefix 再利用も止まる。翻訳の入力が異なる通常条件と、同じ入力を繰り返す条件を分けて採否する。モデルファイルの OPFS キャッシュを制御する `useCache:true` は別の設定。

## 確認結果と統率者の計測

固定版へ cache 単独、および `commands,sampling,cache,cpu` の順で全パッチの `git apply --check --whitespace=error-all`、適用、`git diff --check` が成功した。ビルド・実機計測は統率者が行う。

1. 基準版、0001のみ、0001+0002と `cache_prompt:false` を、同じモデル・入力・同時本数で比較する。0001の cache RAM と checkpoint の寄与を分離する場合は、一方の代入だけを外した計測用 checkout を使う。
2. KV 保存に由来する GPU 読取り bytes・Map 回数・時間、生成終了から要求の完了通知までの時間、次の要求の prefill／decode 時間を測る。logits の読取りと分けて集計する。
3. 異なる入力の連続要求、同時要求、取消後の再実行で、完了した slot の KV が残らず、稼働中の slot の出力・目印が保たれることを確認する。GPU の予約メモリー量は KV セル解放の判定には使わない。

## 出典とライセンス

[sakutto の0005](https://github.com/jammaru/sakutto/blob/73ed0476ed420714131587774b523fae4d61c2c2/scripts/wllama/patches/0005-disable-prompt-cache.patch) を固定版へ移植し、現行の release 条件を保持した。MIT、Copyright (c) 2026 jammaru。

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
