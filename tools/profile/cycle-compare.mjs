// 複数周の実測を並べる。速度の採否には使わず、セットアップ短縮の確認に使う。
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), index = args.indexOf('--loops');
if (index < 0 || !args[index + 1]) throw new Error('--loops DIR[,DIR...] を指定してください');
const lines = ['| 周 | キャッシュ状態 | build 秒 | C++ 秒 / object数 | 共有cache 秒 | Brave・拡張 秒 | モデル読込み 秒 | warm 秒 | 測定 秒 | cleanup 秒 | 全体 秒 |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const directory of args[index + 1].split(',')) {
  const loop = JSON.parse(fs.readFileSync(path.join(directory, 'loop.json'), 'utf8'));
  const report = loop.measurementDirectory ? JSON.parse(fs.readFileSync(path.join(loop.measurementDirectory, 'report.json'), 'utf8')) : { runs: [], timings: { phases: [] } };
  const container = loop.build?.timings?.container;
  const phase = (rows, name) => rows.filter((row) => row.name === name).reduce((sum, row) => sum + row.ms, 0);
  const sessionPhase = (name) => report.runs.reduce((sum, run) => sum + phase(run.timings.phases, name), 0);
  const mode = loop.build?.cacheHit ? '同一入力・成果物再利用' : container?.stats?.cmakeCacheHit ? '差分ビルド' : '構成初回';
  lines.push(`| ${path.basename(directory)} | ${mode} | ${((loop.build?.timings?.totalMs ?? 0) / 1000).toFixed(3)} | ${(phase(container?.phases ?? [], 'C++コンパイル・リンク') / 1000).toFixed(3)} / ${container?.stats?.compiledObjects ?? 0} | ${(phase(report.timings.phases, '共有モデル取得・SHA照合') / 1000).toFixed(3)} | ${(sessionPhase('Brave起動・拡張読込み') / 1000).toFixed(3)} | ${(sessionPhase('モデル取得・読込み・初期生成') / 1000).toFixed(3)} | ${(sessionPhase('ウォームアップ8バッチ') / 1000).toFixed(3)} | ${(sessionPhase('計測本体') / 1000).toFixed(3)} | ${(sessionPhase('後片付け') / 1000).toFixed(3)} | ${(loop.timings.totalMs / 1000).toFixed(3)} |`);
}
lines.push('\nbuildはC++を含む。モデル読込みは最初の短い生成も含む。各行は同じmodels・設定・比較順で比べる。');
const text = lines.join('\n') + '\n';
const output = args.indexOf('--output'); if (output >= 0) fs.writeFileSync(args[output + 1], text); else console.log(text);
