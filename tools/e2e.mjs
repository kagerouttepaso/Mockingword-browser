// 通しの試験。新しい一時プロファイルの Brave に拡張機能を読み込み、主な場面を順に確かめて、○×の一覧を出す。
// 実行：node tools/e2e.mjs   （約3分。最初にモデルを取得する）
// 試験ページは GitHub と同じように厳しい CSP を付けて返す（ページ側のモジュールの読み込みが CSP の下でも動くか）。
// 確かめる場面と読み方は docs/06_開発と検証.md「通しの試験」。
import http from 'node:http';
import path from 'node:path';
import { click, dragSelect, launch, message, reporter, sleep, tabIdOf, toPage } from './lib/browser.mjs';
// 初回読込みの動作を保ち、モデルのバイトだけを共有キャッシュから供給する。
import { enableModelCache } from './lib/browser.mjs';

const SHOTS = path.join(process.env.TEMP ?? '.', 'plamo-e2e-shots');
const PORT = 18990;
const CSS = ':root { ' + Array.from({ length: 60 }, (_, i) => `--highcharts-color-${i}: #2caffe;`).join(' ') + ' }';
const PAGE = (title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font:18px sans-serif;margin:70px 40px">
<h1 id="h"><a href="#top">서울 지하철 4호선</a></h1>
<p id="p1">서울 지하철 4호선은 서울특별시와 경기도를 잇는 수도권 전철 노선이다.</p>
<p id="p2">이 노선은 <a href="https://example.com/a">당고개역</a>에서 출발하여 <a href="https://example.com/b">오이도역</a>까지 운행한다.</p>
<p id="p3">Run <code>npm install</code> before you start, as described in <a href="https://example.com/doc">the setup guide</a>.</p>
<p id="p4">Die Linie 4 der U-Bahn Seoul verbindet Seoul mit der Provinz Gyeonggi.</p>
<p id="ja">これは日本語の段落です。訳しません。</p>
<svg id="chart" width="300" height="60"><style>${CSS}</style><text x="10" y="30">Usage by model for this month</text></svg>
<script nonce="t">setTimeout(() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.innerHTML = '<style>${CSS}</style><text x="5" y="20">Added later chart label</text>'; document.body.appendChild(s); }, 1500);</script>
</body></html>`;

/** 順番の試験のページ：ヘッダー・サイドバー・本文・フッターがすべて画面に入る。本文を先に訳すか。 */
const LAYOUT = `<!doctype html><html><head><meta charset="utf-8"><title>layout</title></head>
<body style="font:14px sans-serif;margin:0;display:grid;grid-template:'h h' auto 'a m' 1fr 'f f' auto / 220px 1fr;height:100vh">
<header style="grid-area:h;padding:4px"><nav>${['Home', 'Products', 'Pricing', 'Documentation', 'Community', 'Sign in'].map((s) => `<a href="#${s}">${s}</a>`).join(' ')}</nav></header>
<aside style="grid-area:a;padding:4px">${['General settings', 'Billing and plans', 'Security log', 'Code security', 'Integrations', 'Developer settings', 'Access tokens', 'Audit log'].map((s) => `<div><a href="#${s}">${s}</a></div>`).join('')}</aside>
<main style="grid-area:m;padding:4px"><h2>Usage by model for this month</h2>
${['Premium requests are counted for each model separately and billed at the end of the month.', 'You can set a budget so that members cannot exceed the amount you have approved.', 'Models marked as preview may change without notice and are not covered by the service level agreement.', 'Organization owners can enable or disable each model for all members at once.', 'Usage reports can be downloaded as a CSV file from the billing overview page.', 'If a member exceeds the budget, requests to premium models are blocked until the next cycle.', 'Discounts apply automatically when the organization is on an annual plan.', 'Contact support if the numbers in this report do not match your invoice.'].map((s, i) => `<p id="m${i}">${s}</p>`).join('')}</main>
<footer style="grid-area:f;padding:4px">${['Terms', 'Privacy', 'Status', 'Contact'].map((s) => `<a href="#${s}">${s}</a>`).join(' ')}</footer>
</body></html>`;

/**
 * 画面内の順番の試験のページ：見出し（h3 と、GitHub のモデル名のような太字の p）→第1段落→本文→注記の順に送るか。
 * 段落は約150字にして、見出しと本文が1つのバッチに入りきらないようにする。
 */
const SENT = (topic, n) => `Paragraph ${n} about ${topic} explains how the setting works for members, how billing is counted each month, and what administrators should check first.`;
const READING = `<!doctype html><html><head><meta charset="utf-8"><title>reading</title></head>
<body style="font:14px sans-serif;margin:20px"><main>
<h3>Default availability for released models</h3>
<p id="lead1">${SENT('released models', 1)}</p><p>${SENT('released models', 2)}</p><p>${SENT('released models', 3)}</p>
<div role="note" style="font-style:italic">*Note: ${SENT('data retention', 4)}</div>
<ul><li><p style="font-weight:600">Anthropic Claude Fable 5</p><div id="lead2">If enabled, ${SENT('the Fable model', 5)}</div><p>${SENT('the Fable model', 6)}</p><p>${SENT('the Fable model', 7)}</p>
<div role="note" style="font-style:italic">*When Fable is used, ${SENT('safety classifiers', 8)}</div></li></ul>
</main></body></html>`;

/** 取り消しの試験のページ：キャッシュに無い文章（ページごとに違う）の5段落。 */
const FRESH = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body style="font:16px sans-serif">
${['Organization roles grant members access', 'Repository rulesets protect important branches', 'Security managers review new alerts', 'Billing managers can download invoices', 'Moderators can block abusive users'].map((s, i) => `<p>${s} on the ${name.slice(1)} page, item ${i + 1}, and the settings take effect immediately.</p>`).join('')}</body></html>`;

/**
 * 段落の中の要素の試験ページ。GitHub のコメントの形（Markdown の改行が <br> になり、太字の見出し・設定の列・ログの行が1つの <p> に並ぶ。
 * 2026-11-16、作者の報告）と、太字の中のリンク・画像・コード・見た目の変わらない span・手で折り返した文を含む段落。
 * 段落を1つのまま訳し、要素が訳文に写し直され、訳文表示で原文側の要素が残らないかを見る（docs/11_設計方針.md「段落のデータの流れ」）。
 */
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12'%3E%3Crect width='12' height='12' fill='%23888'/%3E%3C/svg%3E";
const COMMENT = `<!doctype html><html><head><meta charset="utf-8"><title>comment</title></head><body style="font:14px/1.5 sans-serif;margin:20px;width:700px">
<p id="c1"><strong>Environment</strong><br>
Air Sync 0.2.2 (also seen on 0.2.0)<br>
Obsidian 1.13.7, Windows 11 desktop (a second Android device syncs the same vault)<br>
Backend: Google Drive, built-in connection<br>
<strong>Summary</strong><br>
Google Drive rejects the update because the remote version is <strong>exactly one ahead</strong> of what the plugin expects.</p>
<p id="c2"><strong>Log</strong><br>
[INFO] Sync plan created for the vault<br>
[ERROR] Push failed because the file changed before the update<br>
[WARN] Sync completed with errors</p>
<p id="c3">Read <strong>the <a href="https://example.com/guide">setup guide</a></strong> <img src="${ICON}" width="12" height="12" alt=""> before you change <span class="plain">the settings</span>, and run <code>npm test</code> after<br>
every change, then call <a href="https://example.com/api"><code>navigator.share()</code></a> to report it.</p></body></html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; script-src 'nonce-t'; style-src 'unsafe-inline'",
  });
  res.end(req.url === '/comment' ? COMMENT : req.url === '/layout' ? LAYOUT : req.url === '/reading' ? READING : req.url.startsWith('/cancel') ? FRESH(req.url) : PAGE(req.url));
}).listen(PORT);

const t = reporter();
const b = await launch();
try {
  await enableModelCache(b, { models: ['0.8B'] });
  const settings = await b.eval(b.ext, `chrome.storage.sync.get(null)`);
  t.check('新しく入れたときの設定', settings.settingsVersion === 4 && settings.device === undefined, JSON.stringify(settings));
  await b.eval(b.ext, `chrome.storage.sync.set({ debugLog: true })`);
  // モデルを取得・読み込んでおく（以降の時間に取得を含めない）。
  const warm = Date.now();
  const w = await message(b, { type: 'translate-one', text: 'Warm up the model.' });
  b.modelCache.assertUsed();
  t.check('モデルの取得と読み込み', w?.ok, `${((Date.now() - warm) / 1000).toFixed(1)}秒`);

  // ---- ページ全体 ----
  const page = await b.open(`http://127.0.0.1:${PORT}/p1`);
  const tabId = await tabIdOf(b, page.targetId);
  const t0 = Date.now();
  await message(b, { type: 'page-action', tabId, action: 'trans' });
  const tr = await b.waitFor(async () => {
    const r = await b.eval(page.session, `({ n: document.querySelectorAll('.plamo-tr').length, p2: document.querySelector('#p2 .plamo-tr')?.innerHTML, p3: document.querySelector('#p3 .plamo-tr')?.innerHTML, svg: document.querySelectorAll('svg .plamo-tr, svg [data-plamo-orig]').length, ja: !!document.querySelector('#ja .plamo-tr') })`);
    return r.n >= 5 && r;
  }, 60000);
  t.check('ページ全体を訳す（5段落）', tr?.n === 5, `${((Date.now() - t0) / 1000).toFixed(1)}秒`);
  t.check('段落の中のリンクが訳文に残る', (tr?.p2?.match(/<a href="https:\/\/example.com\/[ab]">/g) ?? []).length === 2, tr?.p2);
  t.check('インラインコードが原文のまま残る', /<code>npm install<\/code>/.test(tr?.p3 ?? '') && /setup guide|セットアップ/.test(tr?.p3 ?? ''), tr?.p3);
  // 原文側のインラインコードは、中身を隠すと余白と背景の空の箱が残るので、要素ごと隠す（2026-11-11、GitHub の README）。
  const codes = await b.eval(page.session, `(() => { const w = (e) => Math.round(e?.getBoundingClientRect().width ?? -1); return { orig: w(document.querySelector('#p3 > code')), tr: w(document.querySelector('#p3 .plamo-tr code')) }; })()`);
  t.check('原文側のインラインコードが空の箱で残らない', codes.orig === 0 && codes.tr > 0, JSON.stringify(codes));
  t.check('SVG の中（CSS・文字）と日本語は訳さない', tr && tr.svg === 0 && !tr.ja);
  await sleep(2000);
  t.check('後から足された SVG も訳さない', (await b.eval(page.session, `document.querySelectorAll('svg .plamo-tr').length`)) === 0);
  await b.screenshot(page.session, path.join(SHOTS, 'page.png'));


  // ---- 表示の切り替えと、同じサイト内の移動 ----
  await message(b, { type: 'page-action', tabId, action: 'both' });
  await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/p2` }, page.session);
  const next = await b.waitFor(async () => {
    const r = await b.eval(page.session, `({ n: document.querySelectorAll('.plamo-tr').length, mode: document.documentElement.getAttribute('data-plamo-mode') })`);
    return r.n >= 5 && r;
  }, 30000);
  t.check('同じサイトの別のページも対訳のまま自動で訳す', next?.mode === 'both', JSON.stringify(next));
  t.check('ボタンのメニューが「元のページに戻す」になる', (await toPage(b, tabId, { type: 'get-state' }))?.translating === true);
  // 描き直し（hydration）が同じ文字のノードをラッパーの外へ入れ直し、訳文を外しても、訳文に戻る（2026-11-11、行き来で冒頭が原文のまま残った件）。
  await b.eval(page.session, `(() => { const p = document.getElementById('p1'); const texts = [...p.querySelectorAll('[data-plamo-orig]')].flatMap((w) => [...w.childNodes]); p.replaceChildren(...texts); })()`);
  const back = await b.waitFor(async () => {
    const r = await b.eval(page.session, `(() => { const p = document.getElementById('p1'); return { tr: !!p.querySelector('.plamo-tr'), raw: [...p.childNodes].some((c) => c.nodeType === 3 && c.data.trim()) }; })()`);
    return r.tr && !r.raw && r;
  }, 5000);
  t.check('描き直しで外された訳文を出し直す', !!back, JSON.stringify(back));
  // サイトが原文のラッパーの印を消す・訳文の要素を外す（属性やノードを作り直す描き直し）と、同じ出し直しの経路で戻る（2026-11-23）。
  await b.eval(page.session, `(() => { const p = document.getElementById('p1'); p.querySelector('[data-plamo-orig="done"]')?.setAttribute('data-plamo-orig', ''); document.getElementById('p2')?.querySelector('.plamo-tr')?.remove(); })()`);
  const restored = await b.waitFor(async () => {
    const r = await b.eval(page.session, `(() => { const p1 = document.getElementById('p1'); const p2 = document.getElementById('p2'); return { done: [...p1.querySelectorAll('[data-plamo-orig]')].every((w) => w.getAttribute('data-plamo-orig') === 'done'), tr: !!p2?.querySelector('.plamo-tr') }; })()`);
    return r.done && r.tr && r;
  }, 5000);
  t.check('サイトが消した印・外した訳文を出し直す', !!restored, JSON.stringify(restored));
  // サイトが html の className を作り直したり属性を消したりしても、表示（ここでは対訳）を保つ（2026-11-23、Discord でキー入力のたびに訳文が隠れた件）。
  await b.eval(page.session, `document.documentElement.className = 'site-rewrite'; document.documentElement.removeAttribute('data-plamo-mode')`);
  await sleep(100);
  const kept = await b.eval(page.session, `document.documentElement.getAttribute('data-plamo-mode')`);
  t.check('サイトが html の class・属性を書き換えても表示を保つ', kept === 'both', JSON.stringify(kept));
  await message(b, { type: 'page-action', tabId, action: 'stop' });
  await sleep(500);
  const stopped = await b.eval(page.session, `({ tr: document.querySelectorAll('.plamo-tr').length, wraps: document.querySelectorAll('[data-plamo-orig]').length, mode: document.documentElement.getAttribute('data-plamo-mode'), bar: !!document.querySelector('.plamo-ui-host') })`);
  t.check('元のページに戻す', stopped.tr === 0 && stopped.wraps === 0 && stopped.mode === null && !stopped.bar, JSON.stringify(stopped));
  const auto = await b.eval(b.ext, `chrome.storage.session.get(null)`);
  t.check('元に戻すと同じサイトの自動翻訳も止まる', !Object.keys(auto).some((k) => k.startsWith('auto:')));

  // ---- 選択した段落 ----
  await b.eval(page.session, `(() => { const r = document.createRange(); r.setStart(document.querySelector('#p1').firstChild, 5); r.setEnd(document.querySelector('#p2').lastChild, 3); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
  await toPage(b, tabId, { type: 'translate-selected-paragraphs', mode: 'trans' });
  const sel = await b.waitFor(async () => {
    const r = await b.eval(page.session, `({ p1: !!document.querySelector('#p1 .plamo-tr'), p2: !!document.querySelector('#p2 .plamo-tr'), n: document.querySelectorAll('.plamo-tr').length })`);
    return r.p1 && r.p2 && r;
  }, 20000);
  t.check('選択した段落を訳す（選択にかかる2段落だけ）', sel?.n === 2, JSON.stringify(sel));
  await message(b, { type: 'page-action', tabId, action: 'stop' });

  // ---- 選択範囲の「訳」アイコンと吹き出し ----
  await click(b, page.session, 900, 800);
  await dragSelect(b, page.session, '#p4', 2, 500);
  const icon = await b.eval(page.session, `(() => { const h = document.querySelector('html > .plamo-ui-host'); return h ? { x: parseFloat(h.style.left) + 14, y: parseFloat(h.style.top) + 14 } : null; })()`);
  t.check('文章を選ぶと「訳」アイコンが出る', !!icon);
  if (icon) {
    await click(b, page.session, icon.x, icon.y);
    const bubble = await b.waitFor(async () => {
      const s = await b.eval(page.session, `document.querySelector('.plamo-bubble')?.innerText ?? ''`);
      return s && !s.startsWith('翻訳中') && s;
    }, 20000);
    t.check('アイコンを押すと吹き出しに訳が出る', /テキスト翻訳で開く/.test(bubble ?? ''), bubble?.replace(/\s+/g, ' '));
    await b.screenshot(page.session, path.join(SHOTS, 'bubble.png'));
  }
  await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, page.session);
  await click(b, page.session, 900, 800);
  await dragSelect(b, page.session, '#ja', 2, 300);
  t.check('日本語を選んでもアイコンは出ない', !(await b.eval(page.session, `!!document.querySelector('html > .plamo-ui-host')`)));

  // ---- 段落の中の要素（<br>・太字・リンク・画像・コード。GitHub のコメント） ----
  const cm = await b.open(`http://127.0.0.1:${PORT}/comment`);
  const cmTab = await tabIdOf(b, cm.targetId);
  const cmBefore = await b.eval(cm.session, `Math.round(document.getElementById('c1').getBoundingClientRect().height)`);
  await message(b, { type: 'page-action', tabId: cmTab, action: 'trans' });
  // 訳文の中の要素の数と、訳文表示で見えたまま残る原文側の要素（段落の直下の要素のうち訳文以外）。
  const PARA = (id) => `(() => { const p = document.getElementById('${id}'); const trs = p.querySelectorAll('.plamo-tr'); const tr = trs[0]; const r = p.getBoundingClientRect();
    const shown = [...p.children].filter((e) => !e.classList.contains('plamo-tr') && getComputedStyle(e).display !== 'none').map((e) => e.tagName);
    return { n: trs.length, br: tr?.querySelectorAll('br').length, strong: tr?.querySelectorAll('strong').length, linkInBold: !!tr?.querySelector('strong > a[href="https://example.com/guide"]'),
      img: tr?.querySelectorAll('img').length, codeLink: !!tr?.querySelector('a[href="https://example.com/api"] > code'), code: tr?.querySelectorAll('code').length, plainSpan: tr?.querySelectorAll('span.plain').length, shown,
      gapTop: Math.round((tr?.getBoundingClientRect().top ?? 0) - r.top), height: Math.round(r.height), html: tr?.innerHTML }; })()`;
  const cmTr = await b.waitFor(async () => {
    const r = { c1: await b.eval(cm.session, PARA('c1')), c2: await b.eval(cm.session, PARA('c2')), c3: await b.eval(cm.session, PARA('c3')) };
    return r.c1.n && r.c2.n && r.c3.n && r;
  }, 60000);
  t.check('<br> の並ぶ段落を1つのまま訳し、訳文に改行と太字が残る', cmTr?.c1.n === 1 && cmTr.c1.br === 5 && cmTr.c1.strong === 3 && cmTr.c2.br === 3 && cmTr.c2.strong === 1, `${cmTr?.c1.html} ／ ${cmTr?.c2.html}`);
  t.check('訳文表示で原文側の <br>・太字が残らない', cmTr && cmTr.c1.shown.length === 0 && cmTr.c2.shown.length === 0 && cmTr.c3.shown.length === 0 && cmTr.c1.gapTop < 8 && cmTr.c1.height <= cmBefore * 1.2,
    `見えたままの原文の要素 ${JSON.stringify([cmTr?.c1.shown, cmTr?.c2.shown, cmTr?.c3.shown])}・上の隙間 ${cmTr?.c1.gapTop}px・高さ ${cmBefore}→${cmTr?.c1.height}px`);
  t.check('太字の中のリンク・画像・コード・中がコードだけのリンクが訳文に写り、見た目の同じ span と文の途中の <br> はマーカーにしない', cmTr?.c3.linkInBold && cmTr.c3.img === 1 && cmTr.c3.code === 2 && cmTr.c3.codeLink && cmTr.c3.br === 0 && cmTr.c3.plainSpan === 0, cmTr?.c3.html);
  await message(b, { type: 'page-action', tabId: cmTab, action: 'both' });
  await sleep(300);
  const cmBoth = await b.eval(cm.session, `(() => { const p = document.getElementById('c1'); return { orig: [...p.querySelectorAll(':scope > br')].filter((x) => getComputedStyle(x).display !== 'none').length, tr: p.querySelectorAll('.plamo-tr br').length }; })()`);
  t.check('対訳で原文と訳文のどちらも改行する', cmBoth.orig === 5 && cmBoth.tr === 5, JSON.stringify(cmBoth));
  await b.screenshot(cm.session, path.join(SHOTS, 'comment-both.png'));
  await message(b, { type: 'page-action', tabId: cmTab, action: 'trans' });
  await sleep(300);
  await b.screenshot(cm.session, path.join(SHOTS, 'comment.png'));
  await message(b, { type: 'page-action', tabId: cmTab, action: 'stop' });
  await b.send('Target.closeTarget', { targetId: cm.targetId });

  // ---- 訳す順番（本文を先に、ナビ・サイドバー・ヘッダー・フッターを後に）、途中の装飾、訳し終わった行から出す ----
  const lay = await b.open(`http://127.0.0.1:${PORT}/layout`);
  const layTab = await tabIdOf(b, lay.targetId);
  await b.eval(lay.session, `(() => {
    window.__arrived = [];
    window.__working = 0;
    new MutationObserver((recs) => {
      for (const r of recs) {
        for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('plamo-tr')) window.__arrived.push({ t: performance.now(), where: n.closest('main') ? 'main' : 'nav' });
        if (r.type === 'attributes' && r.target.hasAttribute('data-plamo-working')) window.__working++;
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-plamo-working'] });
  })()`);
  await message(b, { type: 'page-action', tabId: layTab, action: 'trans' });
  const order = await b.waitFor(async () => {
    const r = await b.eval(lay.session, `({ arrived: window.__arrived, working: window.__working, left: document.querySelectorAll('[data-plamo-working]').length })`);
    return r.arrived.length >= 19 && r.left === 0 && r; // 本文9段落（見出し＋8）、サイドバー8段落、ヘッダー・フッター各1段落（リンクが1行に並ぶ）
  }, 90000);
  const mains = order?.arrived.filter((a) => a.where === 'main') ?? [];
  const navs = order?.arrived.filter((a) => a.where === 'nav') ?? [];
  t.check('本文もナビもすべて訳す', mains.length >= 9 && navs.length >= 10, `本文 ${mains.length}・ナビ ${navs.length}`);
  // 順番は「送った順」で見る（このページは4バッチで同時に送るので、届いた順は送った順を表さない）。調査用のログの送信を使う。
  const sends = ((await message(b, { type: 'logs-get' }))?.logs ?? []).filter((l) => l.event === '送信' && l.page === '127.0.0.1' && l.texts?.some((s) => /Premium|General settings|Home|Terms|Usage by model/.test(s)));
  const isMain = (s) => s.texts.some((x) => /Premium|budget|Usage by model|preview|Organization owners|CSV|exceeds|Discounts|Contact support/.test(x));
  const isNav = (s) => s.texts.some((x) => /General settings|Billing and plans|Audit log|<a1>Home|<a1>Terms/.test(x));
  const lastMain = sends.findLastIndex(isMain);
  const firstNav = sends.findIndex(isNav);
  t.check('本文のバッチをナビより先に送る', lastMain >= 0 && firstNav >= 0 && lastMain < firstNav, sends.map((s) => (isMain(s) ? '本文' : '') + (isNav(s) ? 'ナビ' : '')).join(' → '));
  t.check('訳している途中の段落に印が付き、終わると外れる', order?.working > 0 && order?.left === 0, `印 ${order?.working}回`);
  const mainTimes = mains.map((a) => Math.round(a.t)).sort((x, y) => x - y);
  t.check('バッチの中で訳し終わった行から先に出る', new Set(mainTimes.map((x) => Math.round(x / 100))).size > 2, `本文の訳文が届いた時刻のばらつき ${mainTimes.at(-1) - mainTimes[0]}ms`);
  await b.screenshot(lay.session, path.join(SHOTS, 'layout.png'));

  // ---- 画面内の順番（見出し→第1段落→本文→注記） ----
  const rd = await b.open(`http://127.0.0.1:${PORT}/reading`);
  await message(b, { type: 'page-action', tabId: await tabIdOf(b, rd.targetId), action: 'trans' });
  await b.waitFor(async () => (await b.eval(rd.session, `document.querySelectorAll('[data-plamo-working]').length === 0 && document.querySelectorAll('.plamo-tr').length >= 10`)), 90000);
  const rsends = ((await message(b, { type: 'logs-get' }))?.logs ?? []).filter((l) => l.event === '送信' && l.texts?.some((x) => /Paragraph \d|Default availability|Anthropic Claude Fable/.test(x)));
  const tierOf = (x) => (/^Default availability|^Anthropic Claude Fable 5$/.test(x) ? 0 : /Paragraph [15] /.test(x) ? 1 : /^\*/.test(x) ? 3 : 2);
  const tiers = rsends.map((l) => l.texts.map(tierOf));
  const lastFront = tiers.findLastIndex((ts) => ts.some((x) => x <= 1));
  const firstBack = tiers.findIndex((ts) => ts.some((x) => x >= 2));
  t.check('画面内は見出しと第1段落を本文・注記より先に送る', rsends.length > 0 && tiers[0].includes(0) && lastFront < firstBack, tiers.map((ts) => ts.join('')).join(' → '));

  // ---- 同じタブで次のページへ移っても、前のページで取り消した番号のリクエストを捨てない ----
  // 番号はページごとに1から振り直す。Service Workerが取り消した番号を覚え続けていたので、次のページの最初のバッチが即座に取り消され、
  // 画面の上の段落が訳されずに残っていた（2026-11-12、GitHub の組織設定のページ群を行き来したときの作者のログ）。
  const rdTab = await tabIdOf(b, rd.targetId);
  await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/cancelA` }, rd.session); // 同じサイトなので自動で訳し始める
  const working = await b.waitFor(async () => (await b.eval(rd.session, `document.querySelectorAll('[data-plamo-working]').length`)) > 0, 20000, 20);
  await b.eval(rd.session, `document.querySelectorAll('p').forEach((e) => e.remove())`); // 訳している途中の段落が消える → 取り消し
  await sleep(1500);
  await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/cancelB` }, rd.session);
  const after = await b.waitFor(async () => {
    const n = await b.eval(rd.session, `document.querySelectorAll('.plamo-tr').length`);
    return n >= 5 && n;
  }, 30000);
  t.check('前のページで取り消した後も、同じタブの次のページを全部訳す', !!working && after === 5, `訳した段落 ${after || (await b.eval(rd.session, `document.querySelectorAll('.plamo-tr').length`))}/5`);
  await message(b, { type: 'page-action', tabId: rdTab, action: 'stop' });
  await b.send('Target.closeTarget', { targetId: rd.targetId });

  // ---- テキスト翻訳（言語の混ざった2行）----
  const text = await b.open(`chrome-extension://${b.extensionId}/ui/translate.html`);
  await b.eval(text.session, `(() => { const i = document.getElementById('input'); i.value = '이 노선은 당고개역에서 출발한다.\\n\\nLa ligne 4 relie Séoul à Gyeonggi.'; i.dispatchEvent(new Event('input')); })()`);
  const out = await b.waitFor(async () => {
    const o = await b.eval(text.session, `({ out: document.getElementById('output').textContent, foot: document.getElementById('foot').textContent })`);
    return /^PLaMo .*秒/.test(o.foot) && o;
  }, 30000);
  const lines = (out?.out ?? '').split('\n').filter(Boolean);
  t.check('テキスト翻訳で言語の混ざった行をそれぞれ訳す', lines.length === 2 && lines.every((l) => /[ぁ-んァ-ン一-龥]/.test(l)), out?.out?.replace(/\n/g, ' / '));

  // 長文：貼り付けた時点で入力欄が伸び、訳し終わる前から訳文と速さ（tok/s）が出る。
  const para = 'The quarterly report shows steady growth in all regions, and the team plans to expand the service to three new cities next spring. ';
  const long = Array.from({ length: 6 }, (_, i) => `${i + 1}. ${para.repeat(3)}`).join('\n\n');
  const before = await b.eval(text.session, `document.getElementById('input').offsetHeight`);
  await b.eval(text.session, `(() => { const i = document.getElementById('input'); i.value = ${JSON.stringify(long)}; i.dispatchEvent(new Event('input')); })()`);
  const grown = await b.eval(text.session, `document.getElementById('input').offsetHeight`);
  t.check('テキスト翻訳の入力欄が長文を入れた時点で伸びる', grown > before * 1.5, `${before}px → ${grown}px`);
  let midway = null;
  await b.waitFor(async () => (await b.eval(text.session, `document.getElementById('foot').textContent`)).startsWith('翻訳中'), 10000, 50); // 前の訳の表示を拾わない
  const done = await b.waitFor(async () => {
    const o = await b.eval(text.session, `({ out: document.getElementById('output').textContent, foot: document.getElementById('foot').textContent })`);
    if (!midway && /^翻訳中… \d+トークン・[\d.]+ tok\/s/.test(o.foot) && o.out.length > 0) midway = o;
    return /^PLaMo .*tok\/s$/.test(o.foot) && o;
  }, 120000, 100);
  t.check('テキスト翻訳で訳し終わる前から訳文とトークン/秒が出る', !!midway && !!done && midway.out.length < done.out.length, midway ? `途中 ${midway.out.length}字（${midway.foot}）→ ${done?.out.length}字（${done?.foot}）` : `途中が出ない：${done?.foot}`);

  const stats = await message(b, { type: 'cache-stats' });
  t.check('設定画面にキャッシュの件数と大きさが出る', stats?.count > 0 && stats?.bytes > 0, `件数 ${stats?.count}・約 ${Math.round((stats?.bytes ?? 0) / 1024)} KB・全体 ${Math.round((stats?.usage ?? 0) / 1e6)} MB`);

  // ---- キャッシュ（モデルを解放し、Service Workerも止めた後）----
  await message(b, { type: 'unload' });
  await b.send('ServiceWorker.enable', {}, b.ext);
  await b.send('ServiceWorker.stopAllWorkers', {}, b.ext);
  await sleep(1500);
  const c0 = Date.now();
  const cached = await message(b, { type: 'translate-one', text: 'Warm up the model.' });
  const st = await message(b, { type: 'status' });
  t.check('キャッシュはモデルもService Workerも無い状態から返る', cached?.ok && !st.loaded && Date.now() - c0 < 1000, `${Date.now() - c0}ms、モデル ${st.loaded}`);

  // ---- CPU ----
  // ---- 今の設定で測る（PCに合わせる調整の1回分） ----
  // 使う GPU の確認：推論エンジンの報告（ggml_webgpu: report）が届き、GPU の名前か使えない理由が返る。報告の形が拡張機能とずれると黙って何も出なくなるため。
  const gc = await message(b, { type: 'gpu-check' });
  t.check('使う GPU を確かめる', gc?.ok && gc.error !== 'no report' && (gc.ready ? !!gc.adapter : !!gc.error), JSON.stringify({ ready: gc?.ready, adapter: gc?.adapter, distinct: gc?.distinct, error: gc?.error, source: gc?.source }));
  const sp = await message(b, { type: 'speed-test' });
  const spRow = sp?.result?.rows?.[0];
  t.check('今の設定で速さを測る', sp?.ok && sp.result.kind === 'speed' && spRow?.ms > 0 && spRow?.tps > 0, sp?.ok ? `${spRow.label}、${(spRow.ms / 1000).toFixed(1)}秒、${spRow.tps} トークン/秒、${sp.result.adapter ?? sp.result.device}` : JSON.stringify(sp));

  await b.eval(b.ext, `chrome.storage.local.set({ device: 'cpu', threads: 4 })`);
  await sleep(1000);
  const cpu0 = Date.now();
  const cpu = await message(b, { type: 'translate-one', text: 'The CPU mode should also translate this sentence.' });
  const cs = await message(b, { type: 'status' });
  t.check('CPU・4スレッドで訳す', cpu?.ok && cs.device === 'cpu' && cs.threads === 4, `${((Date.now() - cpu0) / 1000).toFixed(1)}秒（読み込みを含む）`);
  await b.eval(b.ext, `chrome.storage.local.set({ device: 'auto', threads: 0 })`);

  // ---- 未使用時の解放 ----
  await message(b, { type: 'translate-one', text: 'Load the model again.' });
  await b.eval(b.ext, `chrome.storage.session.set({ lastUse: 1 })`);
  const gone = await b.waitFor(async () => !(await b.targets()).some((x) => x.url.endsWith('/offscreen/offscreen.html')), 90000, 1000);
  t.check('使わない時間が続くとモデルを解放する', gone);

  const logs = (await message(b, { type: 'logs-get' }))?.logs ?? [];
  t.check('調査用のログが残る', logs.length > 0, `${logs.length}件`);
} catch (e) {
  t.check('試験が最後まで進む', false, e.message);
} finally {
  await b.close();
  server.close();
  const ok = t.summary();
  b.modelCache?.assertHealthy();
  console.log(`画面のコピー：${SHOTS}`);
  process.exit(ok ? 0 : 1);
}
