# 計測専用パッチ

0001-host-timeline.patch と 0002-cpu-stages.patch は pins.json の wllama / llama.cpp に適用する。plamo-profile.h と plamo-profile.cpp を専用 checkout の cpp/ にコピーして使う。WebGPUの計測は候補適用後にinstrument-webgpu.mjsで挿入する。baseline にはこの一式を適用しない。

| 記録 | 計測点 |
| --- | --- |
| step | wllama_context::run_loop の入口と出口。空 poll も記録 |
| phase・sequence・requestId | server_batch::token の is_prompt で prefill/decode を数え、id_slot を slot に対応付ける。同居する step は mixed |
| wasmDecode | server の llama_process(DECODE) と、その直後の既存 llama_synchronize |
| sampling | 翻訳の通常生成に使う common_sampler_sample |
| llamaGraph | llama_contextからmodel.build_graphへの3箇所の呼出し |
| backendScheduler | ggml_backend_sched_alloc_graph / graph_compute_asyncの関数全体 |
| selfMs・scopeTree | 子の包含時間を控除した自己時間。親経路ごとにid・parentId・metric・count・ms・selfMs・bytesを保存。同じ親経路の反復は回数として集約 |
| webgpuBuild | ggml_backend_webgpu_build_multi。bind group・引数の書込み・encoder 作成を含む |
| bindGroup・writeBuffer・submit | 各 CreateBindGroup・WriteBuffer・Submit の経過時間と回数。WriteBuffer は API に渡した bytes も記録 |
| queueWait・mapWait・eventWait | 既存待機関数の経過時間と呼出し回数 |
| tensorRead・hostCopy | buffer_get_tensor / buffer_get_tensor_n と、ホストへの memcpy。hostCopy.bytes が実際のコピー量 |
| logitsRows・logitsBytes | 通常 logits の tensor_get_async に渡す行数と bytes。KV・embeddings の読取りと区別 |
| GPU timestamp | profile-gpu の upstream collect_profile_results で pipeline 名別に収集。単位は ms |
| GPU step 合計 | native step の gpuTotalMs・gpuKernelCount・gpuTimingStatus。未収集は null / no-records、丸めで全kernelが0 msでも collected |
| Worker・JS | 既存 Worker 応答へ native レコードを同梱。encode・Worker 内・往復・glue decode・空 poll を対応付ける |

1 step は複数 sequence の token を生成する。sampling の回数と出力行数を持たせ、step 全体の時間と1 token あたりの償却時間を両方残す。poll 対象 requestId と、その step で進んだ sequence の requestId は別々に記録する。

7d7f028 の server_batch::token は id_slot と is_prompt を持つ。render() は id_slot を view の sequence ID に渡す。別型の common_batch に現れる seq_id と区別し、処理段階も token 自身の is_prompt から取得する。profile と profile-gpu はこの同じパッチを使う。

metrics.msには包含関係がある。特に tensorRead は Map 待ち、webgpuBuild は bindGroup と writeBuffer を含む。queueWait / Map 待ちは GPU 実行とブラウザー通知を含み、sampling に遅延同期が入る場合もある。排他集計にはscopeTreeの各nodeのselfMsを使う。stepの自己時間と外側decodeの自己時間はotherWasmへ残す。8区分と検証方法は[集計の定義](../../../profile/perf-metrics.md)を参照する。

native 側は step 終了時に JSON 化し、通常の Worker 応答で主スレッドへ渡す。この上乗せは profile と baseline の全体時間差に含む。profile-gpu は upstream が compute pass と同期を増やすため、カーネルの所在を調べる実行に使う。

GPU の種類別・pipeline 別の時間と回数、step ごとの合計は `round*.json` の `analysis.gpuTiming` と report の `profile.gpuTiming` に保存する。summary は第2回の種類別・pipeline 別と、decode の logits 行数別平均を表示する。GPU ms は compute pass 内の実行・stall を含み、転送専用コマンドや pass 間の空白は含まない。CPU の queueWait・Map 待ちと重なるため、両者を引き算して通常版の空き時間を確定しない。

`profiles/1794232524570` は round2 の353 step中146 stepに timestamp があり、report にも GPU 集計がある。旧 summary の表示が欠落していた。Brave の timestamp-query はこの実行で動作しており、代替 fence 計測への変更は不要。値に65.536 µs単位の丸めが見られるため、短いkernelの0 msを処理なしと解釈しない。

保存済みの結果は次のように再表示する。`--gpu-output` は全round・全stepのGPU合計と内訳を別JSONへ出す。元の計測結果は更新しない。

```powershell
node tools/profile/render.mjs --report "$env:LOCALAPPDATA/plamo-translate-build/profiles/1794232524570/report.json" --output "$env:TEMP/gpu-summary.md" --gpu-output "$env:TEMP/gpu-steps.json"
```

次の一コマンドを リポジトリ直下 で実行すると、commands → sampling → matmul → profile の順で profile-gpu をビルドし、その成果物を0.8B・並列1で計測する。Docker と Brave が使える統率者側で実行する。

```powershell
node --input-type=module -e "import { build } from './tools/wllama/build.mjs'; import { profile } from './tools/profile.mjs'; const b = await build(['--variant','profile-gpu','--patches','tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/matmul']); await profile(['--models','0.8B','--variants',b.artifactId,'--parallel','1','--device','gpu','--quality-replays','0']);"
```

並列4との比較は同じコマンドの `--parallel` の値を `4` にする。通常版の速度判定は baseline 候補と既定baselineを別途比較する。
