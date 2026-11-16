// 訳文をページに書き込む・消す。表示の切り替えは html 要素のクラスと page/page.css だけで行う
// （plamo-mode-trans：訳文、plamo-mode-orig：原文、plamo-mode-both：対訳）。設計は docs/04_ページの翻訳.md「書き込み」。

import { decode } from '../shared/markup.js';
import { state } from './state.js';

const MODES = ['trans', 'orig', 'both'];

/** 表示のクラスを付け替える。null なら外す（元のページ）。 */
export function setModeClass(mode) {
  const html = document.documentElement;
  html.classList.remove(...MODES.map((m) => 'plamo-mode-' + m));
  if (mode) html.classList.add('plamo-mode-' + mode);
}

/** 訳文を見せる表示（訳文か対訳）になっているか。 */
export function showingTranslation() {
  const html = document.documentElement;
  return html.classList.contains('plamo-mode-trans') || html.classList.contains('plamo-mode-both');
}

/** 写した要素から、元の要素の id と拡張機能の印を外す。中の原文のラッパーは外し、訳文は除く。 */
function clean(el) {
  for (const x of [el, ...el.querySelectorAll('[id], [data-plamo-hide]')]) {
    x.removeAttribute('id');
    x.removeAttribute('data-plamo-hide'); // 原文側の印を写すと、訳文表示で訳文の中まで隠れる
  }
  for (const wrap of el.querySelectorAll('[data-plamo-orig]')) wrap.replaceWith(...wrap.childNodes);
  for (const tr of el.querySelectorAll('.plamo-tr')) tr.remove();
  return el;
}

/**
 * 訳文を要素に戻す。マーカーの読み取りと崩れの扱いは shared/markup.js の decode が行い、ここは木を DOM にするだけ：
 * 要素（wrap）は元の要素のコピー（属性はそのまま、中身は訳文）、写す要素・文字の無い要素は元の要素をそのまま写す。
 * 訳文の文字は文字のノードとして入れる（モデルの出力を HTML として解釈しない）。
 */
export function render(translation, marks) {
  const build = (node) => {
    if (node.type === 'text') return document.createTextNode(node.text);
    const el = marks[node.id - 1].el;
    if (node.type !== 'wrap') return clean(el.cloneNode(true));
    const copy = clean(el.cloneNode(false));
    copy.append(...node.children.map(build));
    return copy;
  };
  return decode(translation, marks.map((m) => m.kind)).map(build);
}

/**
 * 原文の文字のノードを <span data-plamo-orig> で包み、ラッパーの並びを返す（既に包んでいればそれを使う）。
 * ラッパーの値は、訳文が届く前は空、届いたら 'done'。訳文表示で隠すのは 'done' のラッパーだけ（page.css）。
 */
function wrapOriginal(para) {
  const wraps = [];
  for (const n of para.nodes) {
    if (!n.isConnected) continue;
    let wrap = n.parentElement;
    if (!wrap?.hasAttribute('data-plamo-orig')) {
      wrap = document.createElement('span');
      wrap.setAttribute('data-plamo-orig', '');
      n.parentNode.insertBefore(wrap, n);
      wrap.appendChild(n);
    }
    wraps.push(wrap);
  }
  return wraps;
}

/**
 * 段落に訳文を書き込む。原文のラッパーに 'done' を付け（訳文表示で隠れる）、訳文の <span class="plamo-tr"> を段落の中へ置く。
 */
export function apply(para, translation) {
  const first = para.translation == null; // 途中表示の後に最後の返事で書き直すときは、数え直さない
  para.translation = translation;
  const nodes = para.nodes.filter((n) => n.isConnected);
  if (nodes.length === 0) return;
  for (const wrap of wrapOriginal(para)) {
    wrap.setAttribute('data-plamo-orig', 'done');
    wrap.removeAttribute('data-plamo-working');
  }
  if (!para.trSpan?.isConnected) {
    const span = document.createElement('span');
    span.className = 'plamo-tr';
    span.lang = 'ja';
    span.setAttribute('translate', 'no');
    // 置き場所：段落の文字をすべて含むいちばん内側の要素（markup の root。太字だけの行・見出しのリンクならその中）の直下で、
    // 最後の文字の後ろ。太字の見出しは太字のまま、見出しのリンクは押せるままになる。
    const root = para.root?.isConnected && para.root.contains(nodes.at(-1)) ? para.root : para.element;
    let anchor = nodes.at(-1).parentNode; // 包んだ span
    while (anchor.parentNode && anchor.parentNode !== root) anchor = anchor.parentNode;
    anchor.parentNode.insertBefore(span, anchor.nextSibling);
    para.trSpan = span;
  }
  para.trSpan.replaceChildren(...render(translation, para.marks));
  // 段落の中の要素（太字・コード・<br>・アイコンなど）は、訳文に写しが入るので、中身がすべてこの段落のものなら訳文表示で丸ごと隠す。
  // 文字だけを隠すと、文字以外の中身が残る（コードの空の箱、<br> の空行。2026-11-11・11-16）。
  for (const el of para.hide ?? []) if (el.isConnected) el.setAttribute('data-plamo-hide', '');
  if (first) state.translated++;
  state.firstScreen.delete(para);
}

/**
 * 訳している途中の段落（送ったバッチ）の属性を付ける・外す。原文の文字を包み、ラッパーに data-plamo-working を付けると、
 * page.css がその原文を少し薄くする。訳を待つだけの段落には付けない。
 */
export function setWorking(paras, on) {
  for (const para of paras) {
    if (on && para.translation != null) continue; // 訳し直しなど、訳文を見せている段落には付けない
    for (const wrap of on ? wrapOriginal(para) : para.nodes.map((n) => n.parentElement).filter((w) => w?.hasAttribute('data-plamo-working'))) {
      if (on) wrap.setAttribute('data-plamo-working', '');
      else wrap.removeAttribute('data-plamo-working');
    }
  }
}

/** 書き込んだ訳文をすべて消し、原文のラッパーを外して元のページに戻す。 */
export function removeAll() {
  for (const span of document.querySelectorAll('.plamo-tr')) span.remove();
  for (const wrap of document.querySelectorAll('[data-plamo-orig]')) wrap.replaceWith(...wrap.childNodes);
  for (const el of document.querySelectorAll('[data-plamo-hide]')) el.removeAttribute('data-plamo-hide');
  setModeClass(null);
}
