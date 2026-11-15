// 未使用時のモデルの解放。最後に訳した時刻を storage.session に置き（裏方が止まっても消えない）、
// 1分おきに見て、設定の分数を過ぎたら見えないページごと閉じる。設計は docs/03_翻訳コア.md「メモリーの解放」。

import { status, unload } from '../core/engine.js';
import { settings } from './config.js';
import { tuning } from './tune.js';

const ALARM = 'idle-check';
let lastMarked = 0;

/** 訳した時刻を残す。書き込みは20秒に1回まで。 */
export async function markUse() {
  const now = Date.now();
  if (now - lastMarked < 20_000) return;
  lastMarked = now;
  await chrome.storage.session.set({ lastUse: now });
}

export async function lastUse() {
  return (await chrome.storage.session.get('lastUse')).lastUse ?? null;
}

export function startIdleCheck() {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const { idleMinutes } = await settings();
  if (!idleMinutes || tuning() || !(await chrome.offscreen.hasDocument())) return;
  if (Date.now() - ((await lastUse()) ?? 0) < idleMinutes * 60_000) return;
  if ((await status()).loading) return; // 初回の取得など、読み込みの途中は解放しない
  await unload();
  console.info(`[Mockingword] ${idleMinutes}分使わなかったのでモデルを解放しました`);
});

// PCごとの調整（動作モード・スレッド数・同時に訳す本数・ubatch）を変えたら、今のモデルを解放する（次に訳すときに新しい設定で読み込む）。
// 速さの調整（tune.js）が試している間は、試す側が読み込みを切り替えるので解放しない。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && !tuning() && (changes.device || changes.threads || changes.parallel || changes.ubatch)) unload();
});
