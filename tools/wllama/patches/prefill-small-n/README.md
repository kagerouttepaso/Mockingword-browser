# N15 第2版：短いNのpipelineの準備完了をモデル読み込み内で待つ

**不採用（2026-11-11）。** 短いNのタイルは、検証環境Aの実際のページの mixed の step で行列積の固定分を Q4_K 46→34ms、Q6_K 18→13ms に縮めた（profile-gpu）。ただし mixed の GPU 合計で縮んだのは1ページ約0.1秒（約1.5%）にとどまる。新しいpipelineを初めて使う停止（1回約0.65秒）を避けるには全22種類を先に準備する必要があり、モデルの読み込みが約3〜4秒延びる見込み（第2版の見積もり、未計測）。得る分より払う分が大きいので採らない。第2版はビルド・計測していない。経緯と数値は `docs/10`「N15 と N1 の検証」。

- 計測した第1版：`v1-trim-single-n-tile.diff`（ビルドに当たらないよう拡張子を変えて残した）。成果物は `baseline-candidate-52ee19091b2a`（単独、実際のページ +20%）と `baseline-candidate-5b59879c423c`（`sampling-stable` と併用、+3.1%）。
- このフォルダーの `0001-trim-single-n-tile.patch` は第2版で、ビルドしていない。

以下は、第2版を作った時点の担当の引継ぎ（未実施の計測手順を含む）。

`0001-trim-single-n-tile.patch` は、8フォルダー13パッチ、最後の `prefill-m8` の後へ当てる候補として作った。固定版は wllama `6647c1e` / llama.cpp `7d7f028`。

第1版は、検証環境Aの実ページで行列積のGPU時間を縮めたが、通常版の全体は単独で+20%、併用で+3.1%となった。第2版はカーネルの計算を保ち、短いNの初回使用で生じる約0.65〜0.7秒の停止を、モデル読み込み時の準備へ移す。

## 原因の確認

第1版は、cacheの有無をデバイス側の準備完了と同じものと見なしていた。今回、次の2箇所を修正した。

- 代表のn3がcacheにあれば、同じ系列の全種類がそろったと見なして先行作成を省いていた。最初の短い原文でn3だけを作った場合、その後に大きいNを扱ってもn6・n7は準備されない。前版の検証は空のcacheから大きいNを入れる順序だけを確かめていた。
- `CreateComputePipeline` はhandleを返す同期APIで、デバイス側の準備完了を待たない。先行作成のループが実行されても、初回使用時にコンパイル待ちが残りうる。

固定版のnativeウォームアップはBOS/EOSの1〜2トークンで、短いN用pipelineをそろえる工程はない。前版の「モデルウォームアップの大きいNで準備される」という想定も修正する。第2版はbackendの生成時に準備し、nativeウォームアップやspeed-testでどの形を通るかに依存しない。

固定版Emdawnの `library_webgpu.js` では、`CreateComputePipelineAsync` はブラウザーの `device.createComputePipelineAsync()` へ渡される。返されたPromiseが完了するとpipelineは追加の待ちなく使用可能となる。[WebGPU仕様のpipeline作成](https://www.w3.org/TR/webgpu/#pipeline-creation)も、同期APIでは初回submitまでのどこかで停止しうることを定めている。

Nが4の倍数かどうかによる `vectorized` の違いは、このケースでは起きない。固定版の条件はKとMの整列、および重みがF32/F16かどうかであり、Q4_K/Q6_Kでは常に0となる。N自体は条件に含まれない。キーのNは生成中のトークンも含み、保存ログでは次の値だった。

| ページ計測内で初めて現れた形 | prefill / 合計N | step / GPU / mapWait |
| --- | ---: | ---: |
| n6、Q4_K/Q6_K、m4/m8 | 38 / 44 | 740 / 74 / 720ms |
| n7、Q4_K/Q6_K、m4/m8 | 47 / 53 | 784 / 83 / 761ms |
| n8、Q4_K/Q6_K、m4 | 55 / 62 | 124 / 100 / 107ms |
| n3、Q4_K/Q6_K、m4/m8 | 14 / 21 | 75 / 57 / 62ms |

`WORK/replays/perf-gpu/candidate-1.json` を `analyzeEvents(d.events).steps` で再集計した。ページの前には、同じモデルを保持したまま短い `translate-one` とspeed-testが実行され、計測ログはその後にresetされる。表の「初めて」はページ計測内での初出である。n3・n8_m4はウォームアップで使用済みか、使用までに非同期の準備が終わっていた説明と整合する。両者の判別にはreset前のpipeline使用・作成時刻が要る。第2版は、どの順番でも全対象pipelineの完了を読み込み時に待つ。

## 第2版の実装と契約

WebGPU backendの初期化時、shader libraryのconstructorで22種類を列挙する。これは `llama_context` の生成中に行われ、モデル読み込みが完了する前に終わる。原文・KV・重みを使ったGPU計算は追加しない。

- Q4_K/Q6_Kの各型につき、m4のn3〜n8を6種類、m8のn3〜n7を5種類用意する。
- 準備用の論理tensorは、Kを量子化のblock長、MをKまたは2Kとする。これで実際のM≤K・M>Kと同じキーを得る。N=24・32・40・48・56・64の代表値を使うが、奇数Nでも同じキーへ対応する。
- 新しい形は `CreateComputePipelineAsync` で作り、同じ `Instance` の `WaitAny` で成功を待ってからcacheへ入れる。失敗時は読み込み中にエラーとし、未完了のhandleへ戻さない。
- 新しい形を選ぶ経路を、F32活性・重みと入力が別bindingの場合に限定する。F16活性や入力のbindingが重なる場合は既存のpipelineを使う。対象外の冷えた組合せを翻訳中に増やさない。

カーネル選択は第1版と同じく、平坦なQ4_K/Q6_K、subgroup matrixなし、共有メモリー上限16KiB以上、M/Kが64の倍数、17≤N≤64を対象とする。幅は `8 × ceil(N/8)`、高さはM≤Kなら32、それ以外なら64とする。N方向のタイル数と重みの総展開量を保ち、shader本体・精度・K方向の加算順序を変えない。GPU名やPC名での分岐は行わない。

第1版の「大きいNを初めて扱ったときに先行作成する」処理は削除した。`warmup: false` でもbackendの準備は完了させる。`sampling-stable`、同梱の既存パッチ、拡張のJSとvendorは変更していない。

## 予測とモデル読み込みの費用

同じカーネルを使うので、親が確認したmixedのGPU合計1846→1753msの傾向を維持する予測である。合計N=44のstepは約90〜110ms、N=53は約100〜120msと見積もる。GPU時間に、停止していないstepで見られた約15〜30msの残り時間を加えた値で、実測前の予測である。

モデル読み込みの追加時間は、cold時に1つのWebGPU backendあたり約3〜4秒を仮置きする。2つの停止の `mapWait − GPU` は合計約1.32秒で、初出8pipelineに相当する。単純に22種類へ外挿すると約3.6秒となる。待ちには通知・転送なども含まれ、ドライバーのcacheも作用するため、これはコンパイル時間の実測値ではない。実装は各種類の完了を順に待ち、GPUでの追加dispatchは行わない。

通常版の全体は、採用済みN1単独の約6.3秒を基準に、N15でさらに約0.1秒の短縮を仮置きする。profile-gpuで消す約1.3秒を、通常版の短縮量へそのまま加算しない。読み込み込みの最初の1ページと、モデル常駐後のページを分けて採否を判断する。

## 検証

拡張のルート リポジトリ直下 で実行する。最後のJSON指定は省略できる。

```powershell
node tools/wllama/patches/prefill-small-n/verify.mjs "$env:LOCALAPPDATA/plamo-translate-build/git/wllama.git" "$env:LOCALAPPDATA/plamo-translate-build/git/llama.cpp.git" "$env:LOCALAPPDATA/plamo-translate-build/replays/perf-gpu/candidate-1.json"
```

固定コミットからの実適用、profile/profile-gpuの計測コード挿入を確認する。C++から抽出した式・準備ループをJSで実行し、22種類の列挙、n3だけがある部分cache、全N=17〜64とモデル寸法での実キーとの一致を確認する。async完了待ちの成功・失敗経路、保存範囲、共有メモリー上限、既存のN1検証も行う。保存ログの新14種類が先行準備に含まれることを照合した。

固定Dawn ZIPのC++ callback引数・`WaitAny` APIとJSのPromiseへの接続は読み取って確認した。C++/WGSLのコンパイルと実GPU計測は親へ引き継ぐ。今回、この担当ではビルド・ブラウザー計測を実行していない。

## ビルドと予定ID

```powershell
$basePatches = 'tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/matmul,tools/wllama/patches/result,tools/wllama/patches/prefill,tools/wllama/patches/matmul-h8,tools/wllama/patches/attn,tools/wllama/patches/prefill-m8'
# 新版単独
node tools/wllama/build.mjs --variant baseline --patches "$basePatches,tools/wllama/patches/prefill-small-n" --plan
# 採用済みN1との併用。ビルド時は --plan を外す。
node tools/wllama/build.mjs --variant baseline --patches "$basePatches,tools/wllama/patches/prefill-small-n,tools/wllama/patches/sampling-stable" --plan
node tools/wllama/build.mjs --variant profile-gpu --patches "$basePatches,tools/wllama/patches/prefill-small-n,tools/wllama/patches/sampling-stable" --plan
```

| 構成 | 第2版の予定ID |
| --- | --- |
| N15単独 | `baseline-candidate-89a5dd4a17af` |
| N1との併用 | `baseline-candidate-32e531ad204a` |
| 併用のprofile-gpu | `profile-gpu-candidate-32e531ad204a` |

IDは計画と適用を確認した段階の値である。N1単独は既存の `baseline-candidate-eeff57105463` のままで、同フォルダーには変更を加えていない。

## 親が確認すること

1. 読み込み直後の最初のページで、n3〜n8の初出に約0.65〜0.7秒の停止が出ないことを確認する。n6・n7だけでなく、n4・n5と端数Nも対象にする。形ごとのstep時間をGPU時間と対応させる。
2. モデル解放後、最初の `translate-one` のモデル側ログ `loadMs` を基準と比べる。`page-replay.mjs` はspeed-testより前にモデルを読み込むため、speed-test側の `loadMs` は追加の準備費用を含まない。ページ計測前のログをresetする前に読み込み時間を取る。
3. 通常版をN1単独と交互3回で比べる。全体・画面内・最初の行、訳文・token数・マーカー・停止位置を確認する。N1のグラフ構築削減と定常decodeが保たれることも見る。

今回のログには、合計N=313のstepにも約182msのqueue待ちがある。n6・n7のmap待ちとは別の待ちで、今回の修正による解消は未確定である。新しいpipelineの初出停止が消えた後もこの待ちが残る場合は、独立して原因を確認する。
