// 訳文をページに書き込む・消す。表示の切り替えは html 要素のクラスと page/page.css だけで行う
// （plamo-mode-trans：訳文、plamo-mode-orig：原文、plamo-mode-both：対訳）。設計は docs/04_ページの翻訳.md「書き込み」。

import { decode, previewLine, remainingSource } from '../shared/markup.js';
import { applyTranslationFont, clearPageFonts } from './fonts.js';
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
  return renderTree(decode(translation, marks.map((m) => m.kind)), marks);
}

function renderTree(tree, marks) {
  const build = (node) => {
    if (node.type === 'text') return document.createTextNode(node.text);
    const el = marks[node.id - 1].el;
    if (node.type !== 'wrap') return clean(el.cloneNode(true));
    const copy = clean(el.cloneNode(false));
    copy.append(...node.children.map(build));
    return copy;
  };
  return tree.map(build);
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
      wrap = document.createElement('mw-orig');
      wrap.setAttribute('data-plamo-orig', '');
      n.parentNode.insertBefore(wrap, n);
      wrap.appendChild(n);
    }
    wraps.push(wrap);
  }
  return wraps;
}

/** 訳文を置く要素。太字だけの行・見出しのリンクなら、その内側に置く。 */
function translationSpan(para, last) {
  if (!para.trSpan?.isConnected) {
    // サイトの CSS（例：.Title span）が誤爆しないよう、汎用 span ではなくカスタム要素名を使う。
    const span = document.createElement('mw-tr');
    span.className = 'plamo-tr';
    span.lang = 'ja';
    span.setAttribute('translate', 'no');
    // 置き場所：段落の文字をすべて含むいちばん内側の要素（markup の root。太字だけの行・見出しのリンクならその中）の直下で、
    // 最後の文字の後ろ。太字の見出しは太字のまま、見出しのリンクは押せるままになる。
    const root = para.root?.isConnected && para.root.contains(last) ? para.root : para.element;
    let anchor = last.parentNode; // 包んだ span
    while (anchor.parentNode && anchor.parentNode !== root) anchor = anchor.parentNode;
    anchor.parentNode.insertBefore(span, anchor.nextSibling);
    para.trSpan = span;
    applyTranslationFont(para, span);
  }
  return para.trSpan;
}

function hideOriginal(para, status) {
  for (const wrap of wrapOriginal(para)) {
    if (wrap.getAttribute('data-plamo-orig') !== status) wrap.setAttribute('data-plamo-orig', status);
    wrap.removeAttribute('data-plamo-working');
  }
  // 段落の中の要素（太字・コード・<br>・アイコンなど）は、訳文に写しが入るので、中身がすべてこの段落のものなら訳文表示で丸ごと隠す。
  // 文字だけを隠すと、文字以外の中身が残る（コードの空の箱、<br> の空行。2026-11-11・11-16）。
  for (const el of para.hide ?? []) if (el.isConnected && el.getAttribute('data-plamo-hide') !== status) el.setAttribute('data-plamo-hide', status);
}

const previewHeight = '--plamo-preview-block-size';

/** 文の途中表示。確定するまでは原文の文数に合わせて末尾を残し、元のブロックの高さを下限にする。 */
export function applyPartial(para, text, complete) {
  if (para.translation != null || (para.trSpan?.isConnected && !para.partial)) return; // 訳し直し中は確定済みの訳を見せる
  if (para.partial?.text === text && para.partial.complete === complete) return;
  const last = para.nodes.findLast((node) => node.isConnected);
  if (!last) return;
  const parts = render(text, para.marks);
  let tail;
  if (!complete) {
    const { sentences } = previewLine(text);
    const rest = renderTree(remainingSource(para.text, para.marks.map((mark) => mark.kind), sentences), para.marks);
    if (rest.length) {
      tail = document.createElement('mw-tail');
      tail.className = 'plamo-source-tail';
      tail.lang = para.element.lang || document.documentElement.lang;
      tail.append(' ', ...rest);
    }
    if (!para.partial) {
      const size = getComputedStyle(para.element).blockSize;
      if (parseFloat(size) > 0 && size.endsWith('px')) para.element.style.setProperty(previewHeight, size);
      para.element.setAttribute('data-plamo-preview-block', '');
    }
  }
  para.partial = { text, complete };
  hideOriginal(para, 'partial');
  const span = translationSpan(para, last);
  span.setAttribute('data-plamo-partial', '');
  span.style.animation = 'none'; // 確定時にも、すでに読めた訳文の不透明度を戻さない
  if (tail) parts.push(tail);
  span.replaceChildren(...parts);
}

function finishPartial(para) {
  if (!para.partial) return;
  para.partial = null;
  para.trSpan?.removeAttribute('data-plamo-partial');
  para.element.removeAttribute('data-plamo-preview-block');
  para.element.style.removeProperty(previewHeight);
}

/** 取り消しや失敗で途中表示を取り下げ、原文へ戻す。 */
export function clearPartial(para) {
  if (!para.partial) return;
  finishPartial(para);
  para.trSpan?.remove();
  para.trSpan = null;
  for (const node of para.nodes) {
    const wrap = node.parentElement;
    if (wrap?.getAttribute('data-plamo-orig') === 'partial') wrap.setAttribute('data-plamo-orig', '');
  }
  for (const el of para.hide ?? []) if (el.getAttribute('data-plamo-hide') === 'partial') el.removeAttribute('data-plamo-hide');
}

/** 確定した訳文で段落を置き換える。途中表示と原文の残りは、確定した書式付きの訳文へ差し替える。 */
export function apply(para, translation) {
  const first = para.translation == null;
  const last = para.nodes.findLast((node) => node.isConnected);
  if (!last) return;
  para.translation = translation;
  hideOriginal(para, 'done');
  const span = translationSpan(para, last);
  // 同じ行をすでに表示していれば子を残し、原文の非表示を確定する。
  if (!para.partial?.complete || para.partial.text !== translation) span.replaceChildren(...render(translation, para.marks));
  finishPartial(para);
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
  for (const para of state.all) clearPartial(para);
  for (const span of document.querySelectorAll('.plamo-tr')) span.remove();
  for (const wrap of document.querySelectorAll('[data-plamo-orig]')) wrap.replaceWith(...wrap.childNodes);
  for (const el of document.querySelectorAll('[data-plamo-hide]')) el.removeAttribute('data-plamo-hide');
  clearPageFonts();
  setModeClass(null);
}
