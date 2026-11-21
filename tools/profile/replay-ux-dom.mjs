export function installUxRecorder() {
  const boundary = 'body, main, article, section, header, footer, nav, aside, div, p, h1, h2, h3, h4, h5, h6, [role=heading], li, dt, dd, th, td, blockquote, figcaption, caption, summary, button, label, [role=menuitem], [role=tab]';
  const excluded = 'script, style, template, noscript, svg, math, pre, code, kbd, samp, textarea, select, input, [contenteditable=true]';
  const excludedOriginal = new WeakSet(document.querySelectorAll('[translate=no]'));
  const hiddenOriginal = '[data-plamo-orig=done], [data-plamo-hide]';
  const heading = 'h1, h2, h3, h4, h5, h6, [role=heading]';
  const main = 'main, article, [role=main]';
  const navigation = 'nav, aside, footer, [role=navigation], [role=menu]';
  const norm = (value) => value.replace(/\s+/gu, ' ').trim();
  const kana = /[\u3041-\u3096\u30a1-\u30fa]/u;
  const japanese = /[\u3041-\u3096\u30a1-\u30fa\u3400-\u9fff]/u;
  const sourceLanguage = /\p{Script=Latin}{2,}|\p{Script=Hangul}{2,}/u;
  const now = () => performance.timeOrigin + performance.now();
  const blocks = [...document.querySelectorAll(boundary)];
  const originalBlocks = new WeakSet(blocks);
  const entries = new Map();
  const range = document.createRange();

  function collectGroups(element, translated) {
    const groups = new Map();
    if (!element.isConnected || element.closest(excluded) || (translated && element.closest(hiddenOriginal))) return groups;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      if (excludedOriginal.has(ancestor)) return groups;
    }
    let nodes = [];
    groups.set(element, nodes);
    function scan(parent) {
      for (const child of parent.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) nodes.push(child);
        else if (child.nodeType === Node.ELEMENT_NODE) {
          if (originalBlocks.has(child)) {
            nodes = [];
            groups.set(child, nodes);
          } else if (!child.matches(boundary) && !child.matches(excluded) && !excludedOriginal.has(child)
            && !(translated && child.matches(hiddenOriginal))) scan(child);
        }
      }
    }
    scan(element);
    return groups;
  }

  function visibility(nodes) {
    let shown = false;
    for (const node of nodes) {
      if (!norm(node.data)) continue;
      const element = node.parentElement;
      let box = element;
      while (box && getComputedStyle(box).display === 'contents') box = box.parentElement;
      if (!box?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const disclosure = element.closest('details:not([open])');
      if (disclosure && !disclosure.querySelector(':scope > summary')?.contains(element)) continue;
      if (element.closest('.sr-only, .visually-hidden')) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width <= 1 || rect.height <= 1) continue;
        shown = true;
        if (rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) return 'viewport';
      }
    }
    return shown ? 'shown' : 'hidden';
  }

  const inventory = [];
  const sections = new Map();
  const readText = (nodes) => norm(nodes.map((node) => node.data).join(''));
  for (const element of blocks) {
    for (const [anchor, nodes] of collectGroups(element, false)) {
      const source = readText(nodes);
      if (!sourceLanguage.test(source) || kana.test(source)) continue;
      const initial = visibility(nodes);
      const paragraph = element.matches('p');
      const section = element.closest(main) ?? document.body;
      let lead = false;
      if (!element.closest(navigation) && initial !== 'hidden') {
        if (element.matches(heading)) { sections.set(section, true); lead = true; }
        else if (paragraph && sections.get(section)) { sections.set(section, false); lead = true; }
      }
      const row = { id: inventory.length + 1, source, initial, lead, paragraph, tag: element.localName,
        collapsed: nodes.some((node) => {
          const disclosure = node.parentElement.closest('details:not([open])');
          return disclosure && !disclosure.querySelector(':scope > summary')?.contains(node);
        }), rendered: source, completeAt: null, firstAt: null, afterScroll: false };
      const fragments = nodes.map((node) => ({ node, text: norm(node.data) })).filter(({ text }) =>
        (text.match(/\p{Script=Latin}{2,}/gu)?.length ?? 0) >= 3 || (text.match(/\p{Script=Hangul}/gu)?.length ?? 0) >= 4);
      inventory.push(row);
      if (!entries.has(element)) entries.set(element, []);
      entries.get(element).push({ row, fragments, anchor });
    }
  }

  const metadata = { viewport: [innerWidth, innerHeight], screen: [screen.width, screen.height],
    available: [screen.availWidth, screen.availHeight], devicePixelRatio, windowPosition: [screenX, screenY],
    charset: document.characterSet, title: document.title, height: document.documentElement.scrollHeight };
  const initialScreen = inventory.filter((row) => row.initial === 'viewport');
  const events = [];
  let startAt = null;
  let scroll = null;
  let scrollAttempted = false;
  function updateRow({ row, fragments }, nodes, at) {
    const rendered = readText(nodes);
    const current = new Set(nodes);
    row.rendered = rendered;
    row.remaining = fragments.filter(({ node, text }) => current.has(node) && norm(node.data) === text).map(({ text }) => text);
    const complete = rendered !== row.source && japanese.test(rendered) && !row.remaining.length;
    if (complete !== (row.completeAt !== null)) {
      row.completeAt = complete ? at : null;
      if (complete) row.firstAt ??= at;
      events.push({ at, id: row.id, complete });
    }
  }
  function update(element, at) {
    const groups = collectGroups(element, true);
    for (const entry of entries.get(element)) updateRow(entry, groups.get(entry.anchor) ?? [], at);
  }
  function tryScroll() {
    if (scrollAttempted || !initialScreen.length || initialScreen.some((row) => row.completeAt === null)) return;
    scrollAttempted = true;
    const before = scrollY;
    const at = now();
    scrollBy({ top: innerHeight, behavior: 'instant' });
    if (scrollY <= before) return;
    scroll = { at, before, after: scrollY };
    for (const [element, records] of entries) {
      const groups = collectGroups(element, true);
      for (const { row, anchor } of records) row.afterScroll = visibility(groups.get(anchor) ?? []) === 'viewport';
    }
  }
  const observer = new MutationObserver((records) => {
    if (startAt === null) return;
    const affected = new Set();
    const at = now();
    for (const record of records) {
      let element = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
      for (; element; element = element.parentElement) if (entries.has(element)) affected.add(element);
      for (const removed of record.removedNodes) {
        if (removed.nodeType !== Node.ELEMENT_NODE || removed.isConnected) continue;
        if (entries.has(removed)) affected.add(removed);
        for (const nested of removed.querySelectorAll(boundary)) if (entries.has(nested)) affected.add(nested);
      }
    }
    for (const element of affected) update(element, at);
    tryScroll();
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['data-plamo-orig', 'data-plamo-hide'] });
  window.__uxReplay = {
    start: () => (startAt = now()),
    snapshot() {
      const at = now();
      if (startAt !== null) for (const element of entries.keys()) update(element, at);
      return { metadata, startAt, observedAt: at, scroll, inventory, events };
    },
  };
  return { metadata, total: inventory.length, hidden: inventory.filter((row) => row.initial === 'hidden').length,
    collapsed: inventory.filter((row) => row.collapsed).length, screen: initialScreen.length };
}
