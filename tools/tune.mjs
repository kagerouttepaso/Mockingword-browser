// 設定画面の「このPCに合わせる」を、新しいプロファイルの Brave で動かして結果の表を出す（開発用。拡張機能の調整そのものの確認と、PCごとの値の記録に使う）。
// 実行：node tools/tune.mjs [--model 0.8B|2B]
// 毎回新しいプロファイルなので、最初にモデルを取得する（0.8Bで約35秒）。
import { launch, message } from './lib/browser.mjs';
// モデルの外部取得は共有キャッシュの初回準備時だけにする。
import { enableModelCache } from './lib/browser.mjs';

const args = process.argv.slice(2);
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : '0.8B';
const b = await launch();
try {
  await enableModelCache(b, { models: [model] });
  await b.eval(b.ext, `chrome.storage.sync.set({ model: '${model}' })`);
  const warm = Date.now();
  await message(b, { type: 'translate-one', text: 'Warm up the model.' });
  b.modelCache.assertUsed();
  console.log(`モデルの取得と読み込み ${((Date.now() - warm) / 1000).toFixed(1)}秒`);
  const t0 = Date.now();
  const r = await message(b, { type: 'tune' });
  if (!r?.ok) throw new Error(JSON.stringify(r));
  const { result } = r;
  console.log(`調整 ${((Date.now() - t0) / 1000).toFixed(1)}秒、${result.model}、${result.device}、${result.adapter ?? ''}`);
  for (const row of result.rows) console.log(`  ${row.label.padEnd(24)} ${row.error ? '読み込めず：' + row.error : `${(row.ms / 1000).toFixed(2)}秒（ばらつき${Math.round(row.spread * 100)}%）  最初 ${(row.firstMs / 1000).toFixed(2)}秒  ${row.tps} トークン/秒  （読み込み ${(row.loadMs / 1000).toFixed(1)}秒）`}`);
  console.log(`選んだ設定：${JSON.stringify(result.chosen)}`);
  const saved = await b.eval(b.ext, `chrome.storage.local.get(['parallel', 'ubatch', 'threads', 'device'])`);
  console.log(`保存された値：${JSON.stringify(saved)}`);
  const st = await message(b, { type: 'status' });
  console.log(`調整後のモデル：${st.loaded ?? '解放済み'}`);
} finally {
  await b.close();
  b.modelCache?.assertHealthy();
  process.exit(0);
}
