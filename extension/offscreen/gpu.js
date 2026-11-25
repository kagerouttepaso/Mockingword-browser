// 推論エンジン（wllama の中の ggml-webgpu）が知らせる GPU の報告を読む。
// GPU を選び、デバイスを取り、検算するのは推論エンジンだけ（tools/wllama/patches/adapter）。拡張機能は GPU を自分で求めず、
// この報告だけを表示と調査用のログに使う。これで、画面に出す GPU と推論に使う GPU がずれない。設計は docs/03「動作モード」。

/** 報告の行の頭。推論エンジンのパッチと合わせる。 */
export const REPORT_PREFIX = 'ggml_webgpu: report ';

/** 推論エンジンのログの1行から報告を取り出す。報告の行でなければ null。 */
export function parseGpuReport(line) {
  if (typeof line !== 'string') return null;
  const at = line.indexOf(REPORT_PREFIX);
  if (at < 0) return null;
  try {
    const report = JSON.parse(line.slice(at + REPORT_PREFIX.length).trim());
    return report && typeof report === 'object' && Array.isArray(report.candidates) ? report : null;
  } catch {
    return null;
  }
}

/** 使っているアダプター（求め方が chosen の候補）。 */
export function chosenAdapter(report) {
  return report?.candidates?.find((c) => c.preference === report.chosen && !c.error) ?? null;
}

/** 画面に出すアダプターの名前（説明・ベンダー・アーキテクチャ）。 */
export function adapterLabel(candidate) {
  if (!candidate) return null;
  return [candidate.description, candidate.vendor, candidate.architecture].filter(Boolean).join(' / ') || 'WebGPU';
}

/**
 * ブラウザーが見せている GPU の数（求め方を変えても同じ GPU なら1）。
 * 1 のとき、単体GPU・外付けGPUがあっても、ブラウザーがそれを出していない可能性がある（Windows の Chrome は求め方の希望を採らない）。
 */
export function distinctAdapters(report) {
  const keys = (report?.candidates ?? []).filter((c) => !c.error)
    .map((c) => [c.vendorId, c.deviceId, c.description, c.architecture].join('|'));
  return new Set(keys).size;
}

/** 調査用のログに残す報告の要約。 */
export function reportSummary(report) {
  if (!report) return { report: null };
  return {
    ready: report.ready,
    adapter: adapterLabel(chosenAdapter(report)),
    chosen: report.chosen,
    distinct: distinctAdapters(report),
    candidates: report.candidates.map((c) => c.error
      ? `${c.preference}: ${c.error}`
      : `${c.preference}: ${adapterLabel(c)} f16=${c.shaderF16} subgroups=${c.subgroups}(${c.subgroupMinSize}-${c.subgroupMaxSize})`),
    device: report.device,
    probe: report.probe,
    error: report.error,
  };
}

/**
 * 画面と調査用のログに渡す GPU の見え方。利用者向けの文にするのは shared/gpu.js（設定画面・ボタンのメニューで同じ文を使う）。
 * report が無いのは、推論エンジンが報告を出さなかったとき（パッチの入っていない WASM など）。
 */
export function gpuView(report) {
  if (!report) return { ready: false, adapter: null, distinct: 0, error: 'no report' };
  return { ready: !!report.ready, adapter: adapterLabel(chosenAdapter(report)), distinct: distinctAdapters(report), error: report.error ?? null };
}

/** 推論エンジンの計算が止まった（WASM ごと止まり、読み込み直すまで使えない）ことを表すエラーか。 */
export function isEngineCrash(error) {
  const text = error?.message ?? String(error ?? '');
  return /\(ABORT\)|wllama has crashed/.test(text);
}
