# decode stepの排他集計

新しい計測はScopeの親経路と自己時間を保存し、CPUのstep時間を8区分へ分ける。以前のJSONはwasmDecodeとsamplingによる粗い排他集計で表示する。新しい計測結果を取得したら、同じrenderコマンドで詳細な表を生成できる。

## 記録する木

[plamo-profile.cpp](../wllama/patches/profile/plamo-profile.cpp)のScopeは、現在の親Scopeと子の包含時間を保持する。終了時にelapsedからchild_msを引いて自己時間とし、elapsedを親の子時間へ加算する。同じmetricを異なる親から呼んでも別nodeに記録する。同じ親経路での繰返しはcount・ms・selfMs・bytesへ集約する。

stepにはscopeTreeを保存する。各nodeの構造は`{ id, parentId, metric, count, ms, selfMs, bytes }`。rootのmetricはstep、parentIdはnullとなる。rootの自己時間はstep実時間から外側Scopeの包含時間合計を引いた値。metricsにもmetricごとのselfMsを保存し、集計時に木との一致を検査する。

```text
step
├─ wasmDecode（run_loop → serverのyield_to_queue lambda）
│  ├─ llamaGraph（model.build_graph）
│  └─ backendScheduler（alloc_graph / graph_compute_async）
│     ├─ webgpuBuild → bindGroup / writeBuffer
│     ├─ submit / queueWait / eventWait
│     └─ tensorRead → submit / mapWait / hostCopy
└─ sampling（common_sampler_sample）
   └─ tensorRead等（遅延読戻しがある場合）
```

上は代表的な経路。実際の呼出し木を保存するため、APIが他の親から呼ばれる場合もその経路を保持する。根拠は[0001-host-timeline.patch](../wllama/patches/profile/0001-host-timeline.patch)、[0002-cpu-stages.patch](../wllama/patches/profile/0002-cpu-stages.patch)、[instrument-webgpu.mjs](instrument-webgpu.mjs)。GPUのAPI呼出し位置は候補パッチの適用後に決定する。

## 排他区分と数値の意味

| 区分 | 加算するnodeの自己時間 |
| --- | --- |
| llamaGraph | llama側のmodel.build_graph（通常実行・reserve・最適化の3箇所） |
| backendScheduler | ggmlのalloc_graphとgraph_compute_async。下位のWebGPU処理を除く |
| webgpuPrepare | webgpuBuild、bindGroup、writeBuffer。encoder等の準備を含む |
| submit | Queue.Submitの呼出し |
| gpuWait | queueWait、eventWait |
| readback | tensorRead、mapWait、hostCopy |
| sampling | sampling。下位の読戻し等を除く |
| otherWasm | 外側wasmDecodeとstepの自己時間 |

Mapが待ったGPU時間はreadbackへ分類する。GPU timestampとJS往復はCPU区間と重なるため別の診断として表示する。

対象はpure decode（phaseがdecode、wasmDecode.countが正）のstep。行数はbatch入力tokensで、logitsRowsやsampling回数とは区別する。各区分の平均は合計msをstep数で割る。説明率は8区分の合計をstep実時間合計で割り、未説明はstep実時間合計との差とする。未説明5%未満の判定には、木の検査に不整合がないことも必要となる。

otherWasmは独立した区分として時間・割合を残す。木が正しければ未説明は丸め誤差程度になり、詳しい処理を特定できていない時間はotherWasmとして見える。これは会計上の整合であり、各処理の高速化余地は実測した区分の大きさから判断する。

集計は親のmsと子のms合計＋親selfMs、rootとstep、metric別counterと木を照合する。未知metric・欠けた親・循環・負値も検出する。負の未説明を0に補正せず、実測の不整合を残す。

## オフライン検証と実行

```powershell
node tools/profile/check-perf-patches.mjs
node tools/profile/render.mjs --report "$env:LOCALAPPDATA/plamo-translate-build/profiles/1794238466335/report.json" --output tools/profile/perf-metrics-results/summary.md
```

check-perf-patchesは固定コミットのローカルmirrorから必要なファイルを一時領域へ取り出す。commands → sampling → matmul → profileの順でgit apply --checkと適用を行い、profile/profile-gpuの共通パッチを検証する。新しいScopeの実時間・未説明5%未満・計測負荷は、新ビルドのBrave計測で確認する。

統率者は拡張のディレクトリで次の1行を実行する。候補のartifactIdはビルド結果から渡す。GPU timestampも採る場合はvariantのprofileをprofile-gpuへ変更する。

```powershell
node --input-type=module -e "import { build } from './tools/wllama/build.mjs'; import { profile } from './tools/profile.mjs'; const b = await build(['--variant','profile','--patches','tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/matmul']); await profile(['--models','0.8B','--variants',b.artifactId,'--parallel','4','--completion-extra','@tools/profile/completion/token-only.json']);"
```

保存済みのsummary.md（計測結果はリポジトリ外に保管）とround2.json（計測結果はリポジトリ外に保管）は旧計測9roundの再集計。candidate第2回はpure decode 140step・324sampled token、全phaseでは337sampled token。旧データの粗いScope説明率は98.418〜98.454%で、新しい8区分の実測は統率者のビルド・計測後に得られる。
