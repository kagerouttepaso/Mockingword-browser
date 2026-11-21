// 保存した MHTML（ブラウザーの「名前を付けて保存」→「ウェブページ、1 ファイル」）を部品に分ける。bench.mjs と page-replay.mjs で使う。
// 返す parts は「URL → { type, body }」。ページを開くときに、この URL への要求だけを部品で返し、ほかの通信は止める。
import fs from 'node:fs';

/**
 * Chrome は、ページ本体の <link rel="stylesheet"> などを `cid:css-…@mhtml.blink` という MHTML の中だけの参照で保存する。
 * cid: は http の要求にならず横取りできないので、この偽の https の場所へ書き換えて部品を返す。
 * 書き換えないと CSS が当たらず、ページが素の HTML の縦長の並びになり、画面内の段落・訳す順番が実際と違ってしまう
 * （2026-11-12、GitHub の組織設定のページで、画面の上半分がヘッダーとナビの素のリストだった）。
 */
const CID_BASE = 'https://mhtml.invalid/cid/';

export function readMhtml(file) {
  const raw = fs.readFileSync(file, 'latin1');
  const boundary = raw.match(/boundary="([^"]+)"/)[1];
  const parts = new Map();
  let main = raw.match(/Snapshot-Content-Location: (\S+)/)?.[1];
  for (const chunk of raw.split('--' + boundary).slice(1)) {
    const sep = chunk.indexOf('\r\n\r\n');
    if (sep < 0) continue;
    const head = chunk.slice(0, sep);
    let loc = head.match(/Content-Location: (\S+)/i)?.[1];
    if (!loc) continue;
    if (loc.startsWith('cid:')) loc = CID_BASE + loc.slice(4);
    const type = head.match(/Content-Type: ([^\r\n;]+)/i)?.[1] ?? 'application/octet-stream';
    const enc = head.match(/Content-Transfer-Encoding: (\S+)/i)?.[1]?.toLowerCase();
    let body = chunk.slice(sep + 4).replace(/\r\n$/, '');
    let buf;
    if (enc === 'base64') buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
    else if (enc === 'quoted-printable') {
      // MHTML は保存するときに改行を CRLF にするので、元の LF に戻す（戻さないと integrity の照合が合わず CSS が捨てられる）。
      body = body.replace(/=\r\n/g, '').replace(/\r\n/g, '\n');
      buf = Buffer.from(body.replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    } else buf = Buffer.from(body, 'latin1');
    // HTML と CSS の中の cid: の参照を、上の偽の場所へ書き換える（integrity の付いた外部の CSS は cid: を含まないので変わらない）。
    if (type === 'text/html' || type === 'text/css') {
      const text = buf.toString('latin1');
      if (text.includes('cid:')) buf = Buffer.from(text.replace(/(["'(])cid:/g, `$1${CID_BASE}`), 'latin1');
    }
    const charset = head.match(/Content-Type:[^\r\n]*(?:\r?\n[\t ][^\r\n]*)*?;\s*charset\s*=\s*"?([\w-]+)/i)?.[1]
      ?? (type === 'text/html' ? buf.subarray(0, 8192).toString('latin1').match(/<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([\w-]+)/i)?.[1] : null)
      ?? 'utf-8';
    parts.set(loc, { type: type.startsWith('text/') ? type + '; charset=' + charset : type, body: buf });
    main ??= loc;
  }
  return { main, parts };
}

/**
 * 部品を返すときの応答ヘッダー。GitHub などは別ドメインの CSS・フォントを crossorigin 付きで読むので、
 * Access-Control-Allow-Origin がないと読み込み自体は通っても捨てられ、CSS の当たらないページになる（2026-11-12）。
 */
export function partHeaders(part) {
  return [{ name: 'Content-Type', value: part.type }, { name: 'Access-Control-Allow-Origin', value: '*' }];
}
