// 段落（para）のデータの正本。段落はページ側のモジュールが共有するただのオブジェクトなので、どのフィールドを
// どのモジュールが書くかをここで決める（docs/11_設計方針.md「段落の状態」。tools/architecture.test.mjs が書き手を検査する）。
// 以前は main.js・queue.js・write.js がそれぞれ思い思いにフィールドを足し、段落の状態（待ち・送信中・途中表示・確定・外された）が
// フィールドの組み合わせで暗黙に決まっていた。

import { worthTranslating } from '../shared/text.js';
import { groupOf } from './collect.js';
import { markup } from './paragraph.js';
import { state } from './state.js';

/**
 * 段落のフィールドと、書いてよいモジュール。読むのはどこからでもよい。
 *
 * | フィールド | 書き手 | 意味 |
 * | element・nodes・text・marks・hide・root・fontFamily・group | page/para.js | 範囲と中身（collect・markup の結果）。group.order だけは queue.js が送る直前に付ける |
 * | region・kind・linky | page/priority.js | 訳す順番の判定のキャッシュ |
 * | translation・trSpan・partial | page/write.js | 確定した訳文・訳文の要素・途中表示 |
 * | revives・changes | page/sync.js | サイトの書き換えへの追従の回数（上限で打ち切る） |
 *
 * 段落がどの状態か（待ち・送信中）は page/queue.js の isQueued、訳文が見えているかは page/write.js の isShown で判定する。
 */
export const PARA_FIELDS = {
  'page/para.js': ['element', 'nodes', 'text', 'marks', 'hide', 'root', 'fontFamily', 'group'],
  'page/priority.js': ['region', 'kind', 'linky'],
  'page/write.js': ['translation', 'trSpan', 'partial'],
  'page/sync.js': ['revives', 'changes'],
};

/** 段落を作り、文字のノードと隠す要素から段落を引けるようにする。訳す価値が無ければ null。 */
export function createPara(element, nodes) {
  const { text, plain, marks, hide, root, fontFamily } = markup(element, nodes);
  if (!worthTranslating(plain)) return null;
  const para = { element, nodes, text, marks, hide, root, fontFamily, group: groupOf(element, nodes), translation: null, trSpan: null };
  for (const n of nodes) {
    state.seen.add(n);
    state.owner.set(n, para);
  }
  for (const el of hide) state.hideOwner.set(el, para);
  return para;
}

/**
 * ページが段落の文字を書き換えた後に、中身を読み直す。文字が変わって訳し直す価値があれば true。
 * 範囲（element・nodes）は変えない。ノードが入れ替わった段落は collect が新しい段落として集める。
 */
export function refreshPara(para) {
  const { text, plain, marks, hide, root, fontFamily } = markup(para.element, para.nodes.filter((n) => n.isConnected));
  if (text === para.text || !worthTranslating(plain)) return false;
  Object.assign(para, { text, marks, hide, root, fontFamily });
  for (const el of hide) state.hideOwner.set(el, para);
  return true;
}

/** 送る直前に、項目のグループを取り直す（DOM の移動に追従する）。 */
export function regroup(para) {
  para.group = groupOf(para.element, para.nodes);
}

/** 段落の文字がページに残っているか。 */
export const connected = (para) => para.nodes.some((n) => n.isConnected);
