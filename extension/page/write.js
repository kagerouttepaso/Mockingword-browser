// 訳文をページに書き込む・消す。表示の切り替えは html 要素のクラスと page/page.css だけで行う
// （plamo-mode-trans：訳文、plamo-mode-orig：原文、plamo-mode-both：対訳）。設計は docs/04_ページの翻訳.md「書き込み」。

import { MARK_TAG } from '../shared/text.js';
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

/**
 * 訳文の目印を要素に戻す。リンクは元のリンクの属性（href など）を写した新しいリンクに訳した文字を入れ、
 * コードは元の要素をそのまま写す。目印が崩れていたら（番号が合わない・閉じていない）、目印を外した文字にする。
 */
export function render(translation, marks) {
  const out = [];
  const text = (s) => document.createTextNode(s.replace(MARK_TAG, ''));
  const re = /<([ac])(\d+)>([\s\S]*?)<\/\1\2>/g;
  let last = 0;
  for (let m; (m = re.exec(translation)); ) {
    if (m.index > last) out.push(text(translation.slice(last, m.index)));
    last = re.lastIndex;
    const original = marks?.[m[1]]?.[Number(m[2]) - 1];
    if (!original) {
      out.push(text(m[3]));
    } else if (m[1] === 'a') {
      const link = original.cloneNode(false);
      link.removeAttribute('id');
      link.removeAttribute('data-plamo-shell'); // 原文側の入れ物の印は写さない（写すと訳文表示で訳文のリンクまで隠れる）
      link.textContent = m[3];
      out.push(link);
    } else {
      const code = original.cloneNode(true);
      code.removeAttribute('id');
      // 原文の文字は訳文が届いたときに <span data-plamo-orig> で包まれている（訳文表示で隠れる）ので、写しでは包みを外す。
      for (const wrap of code.querySelectorAll('[data-plamo-orig]')) wrap.replaceWith(...wrap.childNodes);
      for (const el of [code, ...code.querySelectorAll('[data-plamo-shell]')]) el.removeAttribute('data-plamo-shell');
      out.push(code);
    }
  }
  out.push(text(translation.slice(last)));
  return out;
}

/**
 * 原文の文字のノードを <span data-plamo-orig> で包み、包みの並びを返す（既に包んでいればそれを使う）。
 * 包みの値は、訳文が届く前は空、届いたら 'done'。訳文表示で隠すのは 'done' の包みだけ（page.css）。
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
 * 段落に訳文を書き込む。原文の包みに 'done' を付け（訳文表示で隠れる）、訳文の <span class="plamo-tr"> を段落の中へ置く。
 */
export function apply(para, translation) {
  const first = para.translation == null; // 先出しの後に最後の返事で書き直すときは、数え直さない
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
    // 置き場所：段落の文字がすべて同じリンクの中なら、そのリンクの中（見出しのリンクなどを押せるままにする）。
    // それ以外は、段落の直下で、最後の文字の後ろ。
    let anchor = nodes[nodes.length - 1].parentNode; // 包んだ span
    const links = new Set(nodes.map((n) => n.parentElement.closest('a')));
    const link = links.size === 1 ? [...links][0] : null;
    if (!(link && para.element.contains(link))) {
      while (anchor.parentNode && anchor.parentNode !== para.element) anchor = anchor.parentNode;
    }
    anchor.parentNode.insertBefore(span, anchor.nextSibling);
    para.trSpan = span;
  }
  para.trSpan.replaceChildren(...render(translation, para.marks));
  markShells(para);
  if (first) state.translated++;
  state.firstScreen.delete(para);
}

/** 文字の他に見える中身。これを含む入れ物は隠さない。 */
const VISIBLE_CONTENT = 'img, svg, picture, video, canvas, iframe, object, embed, input, select, textarea, button, math';

/** el の中の文字がすべて訳文表示で隠れる原文か（空白だけのノードは数えない）。 */
function onlyHiddenText(el) {
  if (el.querySelector(VISIBLE_CONTENT)) return false;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/\S/.test(n.data) && !n.parentElement?.closest('[data-plamo-orig="done"]')) return false;
  }
  return true;
}

/**
 * 原文を隠すと中身が空になる入れ物（インラインコード・背景や枠のあるリンクなど）に印（data-plamo-shell）を付け、
 * 訳文表示で入れ物ごと隠す（page.css）。文字だけを隠すと、余白と背景の空の箱が段落の頭に並んで見えた
 * （2026-11-11、GitHub の README で50個。訳文の中には元のコードの写しが入るので、原文側の入れ物は要らない）。
 * 段落の要素と、訳文を中に置いたリンクは隠さない。
 */
function markShells(para) {
  for (const n of para.nodes) {
    if (!n.isConnected) continue;
    let shell = null;
    // 包み（data-plamo-orig）の親から段落の要素の手前まで上がり、中身がすべて隠れる一番外側の入れ物を探す。
    for (let el = n.parentElement?.parentElement; el && el !== para.element && para.element.contains(el); el = el.parentElement) {
      if (el.contains(para.trSpan) || !onlyHiddenText(el)) break;
      shell = el;
    }
    shell?.setAttribute('data-plamo-shell', '');
  }
}

/**
 * 訳している途中の段落（送ったまとまり）の印を付ける・外す。原文の文字を包み、包みに data-plamo-working を付けると、
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

/** 書き込んだ訳文をすべて消し、原文の包みを外して元のページに戻す。 */
export function removeAll() {
  for (const span of document.querySelectorAll('.plamo-tr')) span.remove();
  for (const wrap of document.querySelectorAll('[data-plamo-orig]')) wrap.replaceWith(...wrap.childNodes);
  for (const shell of document.querySelectorAll('[data-plamo-shell]')) shell.removeAttribute('data-plamo-shell');
  setModeClass(null);
}
