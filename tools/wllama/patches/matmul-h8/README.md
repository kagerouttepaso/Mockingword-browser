# H8の反証とworkgroup縮小の診断候補

0002の通常版は同時8本で基準1.683秒→1.804秒（+7.2%）となり、判定幅5%を超えて遅くなった。0002は `matmul-h8` へ隔離された比較候補として維持する。0003は幅広MMVQのworkgroupを256→128へ縮める追加候補で、GPUでの採否は統率者が決める。

`WORK/profiles/1794240769263/summary.md` では、後置基準1.686秒に対しても+7.0%、最初の1まとまりは1.380→1.493秒（+113ms）。中央値の差では、追加121msの約93%が最初の表示までに生じている。候補round3は基準と同じ337tokenでも1.803秒で、出力長だけでは約7%の差を説明しにくい。目印は保持し、訳はreview-required。基準の再試行でも未観測の語順差が1件ある。通常版のnative step記録は0件で、型別のGPU時間は次の比較実験で取得する。

## 4列版と8列版の資源量

WGSLの `accumulate_vec_q_dot` は、列ごとの積を `acc`、量子化入力を `b_qs_cols` と `b_ds_cols` に保持する。以下は32bitスカラー値の個数を数えたレジスタ相当量である。実際のレジスタ割当ては、compilerの配列展開・生存期間・spillに依存する。

| 1 invocationの値 | 4列 | 8列 | 変化 |
| --- | ---: | ---: | ---: |
| acc：NUM_COLS × 4行のf32 | 16 | 32 | 2倍 |
| b_qs_cols：NUM_COLS × vec4のu32 | 16 | 32 | 2倍 |
| b_ds_cols：Q4_Kのvec2<f32> | 8 | 16 | 2倍 |
| b_ds_cols：Q6_Kのf32 | 4 | 8 | 2倍 |
| 主要配列の合計：Q4_K | 40 | 80 | +40 |
| 主要配列の合計：Q6_K | 36 | 72 | +36 |
| 重みのrepack・scale一時値も加えた概算：Q4_K | 48 | 88 | +83% |
| 同：Q6_K | 42 | 78 | +86% |

一時値の概算は、Q4_Kで `a_repacked` 4個、`dm` 2個、`scale_min` 2個を加えた。Q6_Kでは4・1・1個を加えた。ループ添字やアドレス、演算中の一時値はこの外にある。配列のdynamic indexingがscalar化されなければ、private memoryへの退避が増える仮説も残る。

宣言上のshared memoryは `partial_sums[OUTPUTS_PER_WG * WG_SIZE]` のみで、4列・8列とも `4 * 256 * 4 = 4096` バイト／workgroup。列数では増えていない。subgroup経路のbarrierは列ごとに2回なので、1 workgroupあたり4列の8回→8列の16回となる。8行全体のworkgroup数が半分になるため、総barrier訪問数は同じでも、各workgroup内の依存鎖は長くなる。

dot-productの論理回数は、Kループ1回・invocationあたり `NUM_COLS * 4出力行 * 4 dot4` で64→128回。8行全体の仕事量は同じで、半分のworkgroupへ集中する。重みの再読込みだけを減らしても、この演算・reduction費用は残る。

## 優先する原因仮説と予測

最優先はレジスタ圧と仕事の集中による同時実行数・レイテンシ隠蔽の悪化。例えばSMのレジスタ予算を仮に65,536個とし、Q4_Kの48→88個だけで計算すると、256threadのworkgroupは最大5→2組になる。0003の128threadなら最大5組、active warpは32thread/warpの例で16→20へ25%増える。これはレジスタ制約だけの計算例であり、実機のoccupancyを測った値ではない。Q6_Kを42→78個で同じように計算すると、0002と0003のactive warp上限はともに24で、この理由による改善は小さい。

K=1024の例では、K量子化は256要素／block、16thread／blockなので、積のループを実行するthreadは64本。WG256では192本、WG128でも64本がこの積に参加せず、後続reductionへ進む。K<=2048ではWG128によって空のK担当threadとreductionの幅を減らせる。Kが長い行列では各threadのKループが増えるため、型別・shape別の回帰も確認する。

前回の3.5ms予測は撤回する。同じprofileの1行2.676ms、4行6.095msを `T(n)=w+n*c` に当てはめると、`w=1.536ms`、`c=1.140ms`。8列を1組にしてもモデル上は10.654msとなり、実測の8行11.360msに対する改善余地は約6.2%である。これは少数の4行stepからの近似で、wには重み以外の固定費も含まれる。

0003の検証用予測は、0002に対してQ4_Kの8行GPU時間が0.80〜0.95倍、Q6_Kは0.90〜1.00倍。従来profileのQ4_K／Q6_K比率61%／39%で重み付けすると、MMVQは約0.84〜0.97倍となる。レジスタ制約とreductionの仮説が外れれば、この短縮は出ない。Q6_Kだけを4列へ戻す変更は、型別の実測後に判断する。

通常版の基準へ戻すには候補1.804秒から121ms（6.7%）の削減が必要。基準より5%速い1.599秒へ達するには205ms（11.4%）が必要である。通常版のGPU占有比率が未取得なので、kernelの短縮率をそのまま全体時間へ換算しない。

## 一つの比較実験

統率者の別GPU計測が終わってから、Pをカレントにして次の1行を実行する。

```powershell
node tools/wllama/patches/matmul-h8/profile-h8.mjs
```

このコマンドは次の3構成をprofile-gpuでビルドし、同じ `profile.mjs --parallel 8 --models 0.8B` の比較へ渡す。全caseのcompletion-extraは `backend_sampling:true`、`backend_sampling_token_only:true`、`cache_prompt:false`。0002だけの入力とcase JSONは `%TEMP%` に作り、作業用ソースをpatches配下へ置かない。`--plan` はGPU実行をせず、構成と引数だけを確認できる。

| case | パッチ群 | 見る差 |
| --- | --- | --- |
| reference | commands,sampling,matmul,result | 4列の基準 |
| h8_256 | 基準＋matmul-h8の0002だけ | 元の8列化による型別の遅さ |
| h8_128 | 基準＋matmul-h8の0002＋0003 | workgroup縮小による回復 |

`analysis.gpuTiming.steps` のpure decode・tokens=8だけで、型別のGPU ms/stepとms/dispatchを比較する。0003のpipeline名には `_wg128` と `_cols8` が付く。判定は次のように行う。

1. h8_256/referenceでQ4_K・Q6_Kのどちらが5%以上遅くなったかを確認する。両方なら共通のレジスタ・同期費用を優先し、Q6_Kだけなら型固有のrepackやshapeを次に調べる。
2. h8_128/h8_256がQ4_Kで0.95以下、Q6_Kで1.00以下なら0003の予測を支持する。両方とも0.98以上なら、このworkgroup縮小による説明力は小さい。
3. 1行stepも別に比較する。0003は1〜4列の設定を維持する。5〜8列ではKの加算順序が変わり得るため、訳・token差と目印の受入も確認する。profile-gpuの全体秒数は通常版の採用判定と分ける。

## 0003の適用確認

0003は0002の後に適用する。shader設定はcache keyに含まれる型・use_mmvq・num_colsだけから決め、shape依存のcache不整合を増やさない。1〜4列のWG256、出力行数4、q8 scratchの式と単調性は維持する。8列のWG128では、shared memoryが4096→2048バイト、主要レジスタ相当量／workgroupが半分になる。

2026-11-10、基準10本・0002まで11本・0003まで12本・cpu/cache/prefill/attnも含む全18本で、各 `git apply --check --whitespace=error-all`、順次適用、profile計装、`git diff --check` が成功した。WG128／256のKブロック担当3,008件とsubgroup reductionの出力被覆8条件を照合した。0003によってcppの投入経路が変わらないことも比較した。採否の実測は `docs/09_性能の仮説検証.md`「H8」。

GPUのbuild・実行・型別時間・実レジスタ数・spillはホストで確認する。0002のsakutto由来部分の出典・MIT本文は、隣の `matmul/README.md` を参照する。
