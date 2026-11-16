# H7：CPU の準備と GPU 実行の重なり

調査結果は、64カーネル単位の分割 Submit が既に実装されている、というものだった。「全 encode の後、最後にまとめて Submit する」という H7 のコード上の前提は棄却する。今回の条件付きリクエストに従い、追加の最適化パッチは作成していない。

CPU と GPU が実際に重なる時間は、既存の排他集計からは求められない。ブラウザーへの Submit 呼出しと実際の GPU 開始は分けて観測する必要がある。分割粒度を小さくする案は、既存64カーネルを基準とする別の実験として扱う。

## encode・Submit・Map の順序

固定版 llama.cpp `7d7f028` と commands 適用後の `ggml_backend_webgpu_graph_compute` は、ノードを順に encode し、累積カーネル数が `command_submit_batch_size` 以上になった時点で `Finish → param_arena.flush → Submit → param_arena.reset` を実行する。その後、次の encoder で残りのノードを encode する。末尾に余りの Submit がある。

閾値は `WEBGPU_DEFAULT_COMMAND_SUBMIT_BATCH_SIZE = 64u` の1定数。数える単位はカーネルで、ノード数とは異なる。一つのノードが複数カーネルを生成する場合は、閾値を超えたところで区切る。`max_inflight_batches` は `UINT32_MAX` なので、通常の decode では各 Submit の直後に queue wait を挟まない。sampling・matmul 適用後もこの流れは同じ。

GPU profile 版は、グラフ末尾で timestamp の Resolve・コピーを追加 Submit し、その staging buffer を Map して待つ。続いて token ID の読み出しが Copy・Submit・Map・ホストへのコピーを行う。通常版は timestamp 回収を行わず、compute pass もまとめる。GPU profile 版はカーネルごとに pass を作るため、通常版と実行条件が異なる。

## 21.7ms の内訳と測定範囲

根拠は `WORK/profiles/1794239762425/reference-0.8B-visit1-round2.json`。8行 pure decode の29 step は、すべて build_multi 517回、Submit 13回、queue wait 13回、Map 2回だった。Submit 13回には timestamp 回収と token 読取りも含む。ログには Submit の用途別時系列がないため、演算グラフごとの投入位置は追加計測で確かめる。

| 排他区分 | 平均 ms / step | 記録から分かる内容 |
| --- | ---: | --- |
| webgpuPrepare | 3.806 | build_multi の自己時間3.518、bind group 作成0.027、WriteBuffer 0.261。graph 全体の encode 前にまとまった時間ではない。 |
| otherWasm | 2.351 | 外側 decode の自己時間2.038と step の自己時間0.313。 |
| submit | 0.202 | Submit API の呼出し時間。 |
| gpuWait | 1.955 | OnSubmittedWorkDone の実際の待ち。 |
| readback | 13.376 | timestamp の Map 12.890、token の Map 0.434、読取りの残り0.052。 |
| sampling | 0.024 | 8本の採択処理。 |
| 合計 | 21.714 | step の経過時間と一致する。 |

readback の主成分は GPU profile 専用の timestamp Map だった。token のホストコピーは32バイト／step。Map には、その時点で残っている GPU 実行と通知待ちが含まれるため、表の13.376msをデータ転送だけの費用へ帰属させない。

otherWasm は、計測した子 scope の外側にある経過時間である。対象成果物の `ggml-backend.cpp` と `llama-context.cpp` には、現在の `profile/0002-cpu-stages.patch` が追加する scheduler・graph 構築の計測点が入っていなかった。従って llamaGraph／backendScheduler の0は、処理時間が0だった証拠には使えない。otherWasm には、それらの処理に加え、演算ごとの pipeline 選択・引数組立て、encoder の管理、timestamp 回収後の集計などが含まれ得る。2.351msを一律に GPU 開始前の CPU 時間へ割り当てる根拠はない。

同じ29 step の `gpuTotalMs` 平均は15.428msだった。指定された計測フォルダーの8行 decode では、各 round の平均が15.194〜15.456msで、リクエストにある12.8〜13.4msとは異なる。GPU timestamp の合計と wall time は時間軸も意味も異なるため、採否の前に集計対象をそろえる。

## 現行パッチ列の確認

確認した並びは commands の3パッチ、sampling の3パッチ、matmul の2パッチ、profile の2パッチ。固定コミットから対象15ファイルを取り出した一時領域で、各段階の `git apply --check --whitespace=error-all` と適用が成功した。調査中に追加された matmul の `0002-share-weights-across-eight-columns.patch` も含めた。

profile は現行 `apply-patches.mjs` と同じく、旧 WebGPU 節を除いて適用した。WebGPU の計測は、最後に `instrument-webgpu.mjs` が候補適用後の API へ差し込む契約である。今回、その JavaScript adapter の実行とコンパイルはホスト待ち。変更範囲はこの README と統率者向けの進捗追記で、他担当のパッチを編集していない。

このフォルダーには `.patch` がないため、`--patches` の入力には加えない。

## 統率者が実行する比較

次の1行はプロジェクト直下で実行する。現行の同じ候補パッチ列で profile-gpu と通常版をビルドし、`profile.mjs` の入口で同時8本・同じ completion-extra を比較する。これは計測による変化と CPU 内訳を確かめる診断用であり、新しい高速化候補の比較ではない。2ビルド間で候補パッチが変わった場合は止まる。

```powershell
node --input-type=module -e "const {build}=await import('./tools/wllama/build.mjs'); const {profile}=await import('./tools/profile.mjs'); const p='tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/matmul'; const g=await build(['--variant','profile-gpu','--patches',p]); const n=await build(['--variant','baseline','--patches',p]); if(g.artifactId.slice(11)!==n.artifactId.slice(8)) throw Error('候補パッチがビルド間に変わりました'); const x=JSON.stringify({backend_sampling:true,backend_sampling_token_only:true,cache_prompt:false}); await profile(['--models','0.8B','--reference',n.artifactId,'--candidate',g.artifactId,'--parallel','8','--reference-completion-extra',x,'--completion-extra',x]);"
```

有効な重なりを確かめる次の計測点は、graph ごとの encode 開始・最初と最後の Submit・Map 開始の CPU 時刻と、GPU 側の最初と最後の timestamp、カーネル間の空き時間である。これにより、最初の Submit 前の遅れ、batch 間の GPU 待機、最後の Submit 後の待ちを分けて評価できる。計測パッチへの追加は統率者・計測担当へ引き継ぐ。
