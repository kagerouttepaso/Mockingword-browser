// 推論エンジンの GPU の報告（offscreen/gpu.js の gpuView）を、利用者向けの文にする。
// 設定画面・ボタンのメニューは、GPU の名前と状態をここで作った文だけで出す（画面ごとに書き方を変えない）。
// GPU を求めたり選んだりはしない。それは推論エンジンだけがする（docs/03「GPU の選択と、使えない・止まったときの扱い」）。

/** 推論エンジンが GPU を使わない理由（報告の error）を、利用者向けの言葉にする。 */
export function gpuReason(error) {
  if (!error) return '';
  if (error.startsWith('correctness probe')) return 'GPU の計算の確かめで答えが合いませんでした';
  return {
    'no adapter': 'ブラウザーが WebGPU の GPU を出していません',
    'adapter lacks shader-f16': 'この GPU は翻訳に要る16ビットの計算（shader-f16）に対応していません',
    'no device after retries': 'GPU を使う準備ができませんでした',
    'no report': '推論エンジンから GPU の報告がありませんでした',
  }[error] ?? error;
}

/**
 * 使う GPU の欄の1行目。g は gpuView に、計算が止まったときの crashed（理由の文）を足したもの。
 * 計算が止まった・使えないときは、CPU で動くことまで書く。
 */
export function describeGpu(g) {
  if (!g) return '確かめられませんでした';
  if (g.crashed) return `${g.adapter ?? 'GPU'} の計算が止まったため、CPU で動いています`;
  if (!g.ready) return `GPU を使えません（${gpuReason(g.error)}）。CPU で動きます${g.adapter ? `。ブラウザーの GPU：${g.adapter}` : ''}`;
  return g.adapter ?? '名前を取れませんでした';
}

/** 使う GPU の欄の2行目。いつ・どう確かめたかと、ブラウザーが見せている GPU の数。 */
export function describeGpuCheck(g) {
  if (!g?.at) return '';
  const when = new Date(g.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const how = g.source === 'loaded' ? '読み込んだモデルが使っている GPU です' : 'モデルを読み込まずに推論エンジンを起動して確かめました';
  const count = g.distinct ? `。ブラウザーが見せている GPU：${g.distinct}つ` : '';
  return `${when}・${how}${count}`;
}
