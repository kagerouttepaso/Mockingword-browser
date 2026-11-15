// 設定の読み出しと、更新したときの古い設定の移し替え。

import { DEFAULTS, LOCAL_DEFAULTS, normalizeLocal } from '../shared/settings.js';

/**
 * 設定の版。上げると、更新したときに一度だけ古い値を移す。
 * 2：既定のモデルをサーバー2Bからブラウザー内0.8Bへ。3：翻訳サーバーをやめ、ブラウザー内だけにした（2026-11-09、作者の依頼）。
 * 4：動作モード・スレッド数を、同期する sync からPCごとの local へ移した（2026-11-09、PCの性能に合わせて調整するため）。
 */
const SETTINGS_VERSION = 4;
const OLD_MODELS = { 'local-0.8B': '0.8B', 'local-2B': '2B', '2B': '0.8B', '0.8B': '0.8B' };

/** 翻訳のたびに読む設定。同期する設定（sync）とPCごとの設定（local）を合わせる。source は空なら null（自動）。 */
export async function settings() {
  const [s, l] = await Promise.all([chrome.storage.sync.get(DEFAULTS), chrome.storage.local.get(LOCAL_DEFAULTS)]);
  return { ...s, ...normalizeLocal(l), source: s.source || null, idleMinutes: Number(s.idleMinutes) };
}

/** 入れたとき・更新したとき：古い設定を移す。 */
export async function migrate(reason) {
  if (reason === 'update') {
    const { settingsVersion = 1, model, device, threads } = await chrome.storage.sync.get(['settingsVersion', 'model', 'device', 'threads']);
    if (settingsVersion < 3 && model !== undefined) await chrome.storage.sync.set({ model: OLD_MODELS[model] ?? DEFAULTS.model });
    if (settingsVersion < 4) {
      // 同期していた動作モード・スレッド数は、このPCの値として引き継ぐ（ほかのPCは各自の既定から始まる）。
      const moved = {};
      if (device !== undefined) moved.device = device;
      if (threads !== undefined) moved.threads = Number(threads) || 0;
      if (Object.keys(moved).length) await chrome.storage.local.set(moved);
      await chrome.storage.sync.remove(['device', 'threads']);
    }
  }
  await chrome.storage.sync.set({ settingsVersion: SETTINGS_VERSION });
}
