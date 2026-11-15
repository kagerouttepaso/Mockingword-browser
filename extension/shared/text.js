// 文の判定と分割。DOM にも chrome にも触れない純粋な関数だけを置く（Node の単体試験 tools/unit.test.mjs で確かめる）。
// 裏方（core/）・見えないページ（offscreen/）・ページ側（page/）から使う。

/** リンク・インラインコードの目印（<a1>…</a1>、<c1>…</c1>）。page/collect.js が付け、page/write.js が要素に戻す。 */
export const MARK_TAG = /<\/?[ac]\d+>/g;

const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const KANA = /[぀-ヿ]/;

/** 空白をまとめて前後を落とす。 */
export function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** 先頭だけにした文（調査用のログに残すとき）。 */
export function short(text, max = 60) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * ページの段落として訳す価値のある文か。
 * - 日本語（かな）を含む文、文字を含まない記号・数字だけの文は訳さない。
 * - CSS・JavaScript のような文（{ } ; が多い）は訳さない（2026-11-09、グラフ部品の CSS を訳しに行き41秒待たされた）。
 * - 英字1文字（記号代わりの x など）は訳さない。ハングル・漢字は1文字でも語になる（홈＝ホーム）。
 */
export function worthTranslating(text) {
  if (!/\p{L}/u.test(text)) return false;
  if (text.length > 80 && (text.match(/[{};]/g)?.length ?? 0) / text.length > 0.02) return false;
  if (text.length < 2 && !/[\p{Script=Hangul}\p{Script=Han}]/u.test(text)) return false;
  if (KANA.test(text)) return false;
  return true;
}

/** 選択範囲として訳す価値のある文か（「訳」アイコンを出すか）。 */
export function worthSelection(text) {
  return text.length >= 2 && text.length <= 5000 && /\p{L}/u.test(text) && !KANA.test(text);
}

/**
 * まとめ訳しの1行が訳されていないか。原文のままか、文字を含む原文に対して日本語の文字が1つもない。
 * 言語の混ざったまとまりでは、最初の言語の行だけ訳し、残りの行を原文のまま写すことがある
 * （2026-11-09、0.8Bで韓国語・フランス語・ドイツ語の3行）。その行だけ1行ずつ訳し直すために見る。
 * 短い英字の行（3語以下かつ24字以下。製品名・モデル名・ボタン名）は、原文のまま返るのが正しいことが多いので訳し直さない
 * （GitHub Copilot の設定ページで、問い合わせが70回から53回に減った）。
 */
export function untranslated(source, output) {
  const norm = (s) => normalize(s.replace(MARK_TAG, ''));
  const plain = norm(source);
  if (!/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(plain) && plain.split(' ').length <= 3 && plain.length <= 24) return false;
  const out = norm(output);
  return plain === out || (/\p{L}/u.test(plain) && !JAPANESE.test(out));
}

/** 長い1段落を、文の切れ目でおよそ max 字ずつに分ける（1スロット4096トークンに収め、生成の打ち切りも避ける）。 */
export function splitLong(text, max = 1200) {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]*\s*|\n/g) ?? [text];
  const parts = [];
  let current = '';
  for (const s of sentences) {
    if (current && current.length + s.length > max) {
      parts.push(current);
      current = '';
    }
    current += s;
  }
  if (current) parts.push(current);
  return parts;
}

/**
 * 段落の並びを、まとめて訳すまとまりに分ける（1まとまり maxLines 行・maxChars 字まで。Android の画面翻訳と同じ8行・400字）。
 * items は文字列か { text } の並び。並び順は保つ。
 */
export function chunk(items, { maxLines = 8, maxChars = 400 } = {}) {
  const groups = [];
  let group = [];
  let chars = 0;
  for (const item of items) {
    const len = (typeof item === 'string' ? item : item.text).length;
    if (group.length && (group.length >= maxLines || chars + len > maxChars)) {
      groups.push(group);
      group = [];
      chars = 0;
    }
    group.push(item);
    chars += len;
  }
  if (group.length) groups.push(group);
  return groups;
}

/**
 * 画面内で訳す順番の段（小さいほど先）。見出し→見出しの直後の第1段落→本文→注記。
 * パラグラフライティングの文章は、見出しと第1段落を読めば何の話かが分かるので、訳している途中でも先にそれを見せる（docs/04「訳す順番」）。
 * control（ボタン・タブの文字）は本文と同じ段にする。
 */
export const READING_TIER = { heading: 0, lead: 1, body: 2, control: 2, note: 3 };

/** 見た目から見出しらしい短い塊か。太字か本文より大きい字で、80字以内、文末記号で終わらない。 */
export function headingLike(text, { weight = 400, size = 16, base = 16 } = {}) {
  const plain = normalize(text.replace(MARK_TAG, ''));
  return plain.length > 0 && plain.length <= 80 && !/[.!?。！？:：;；,、]$/.test(plain) && (weight >= 600 || size >= base * 1.2);
}

/**
 * DOM順に並んだ段落の種類のうち、見出しの直後の最初の本文を lead（第1段落）にする。
 * 見出しと第1段落の間にあるボタンの文字・注記・ナビ（skip）は飛ばす。次の見出しが来たらそちらの第1段落を探す。
 * kinds：'heading'・'body'・'control'・'note'・'skip' の並び。同じ長さの並びを返す。
 */
export function markLeads(kinds) {
  let waiting = false;
  return kinds.map((kind) => {
    if (kind === 'heading') {
      waiting = true;
      return kind;
    }
    if (kind === 'body' && waiting) {
      waiting = false;
      return 'lead';
    }
    if (kind === 'body') waiting = false;
    return kind;
  });
}

/** 短い項目か。リンク・コードの目印は字数から除き、文末のある短文は本文として扱う。 */
export function shortItem(text) {
  const plain = normalize(text.replace(MARK_TAG, ''));
  return plain.length <= 40 && !/[.!?。！？;；]$/.test(plain);
}

/**
 * 入力トークン数の見込み。英数字は4字で1、記号・非ASCII文字は1字で1とし、改行の余裕も加える。
 * 実際の tokenizer はページ側にないため概算。非英語や記号の多い項目を、字数だけで大きくまとめないために使う。
 */
export function estimatedTokens(text) {
  return (text.match(/[A-Za-z0-9_]+|[^\s]/gu) ?? []).reduce((n, word) =>
    n + (/^[A-Za-z0-9_]+$/.test(word) ? Math.ceil(word.length / 4) : [...word].length), 2);
}

/**
 * 優先順の項目を、DOMで決めた group: { key, kind } ごとにまとめる。DOM自体には触れず、keyは同一性だけを見る。
 * 次の組は従来と同じ優先順で選ぶ。同じグループの短い項目をそこへ集め、本文とは分ける。
 * 8行を目安にし、グループを完結できるときだけ12行まで許す。小さい同種のグループは丸ごと相乗りできる。
 * 大きいグループの片は単独の組にし、400字・入力256トークン見込みで切る。本文は従来の chunk の上限を保つ。
 * contextItemsには送信済み・控えの項目も渡せる。残りが1項目になっても本文へ混ぜず、大きいグループの最後の片も独立させる。
 * definitionsは長い説明も含め、unit（dt+ddの組）を分断しない。order（DOM順）で並べ、予算を超える1組は単独にする。
 */
export function groupedChunk(items, { maxLines = 8, maxChars = 400, maxGroupLines = 12, maxTokens = 256, contextItems = items } = {}) {
  const members = new Map();
  const itemGroups = new Map();
  for (const item of items) {
    if (!item.group || (item.group.kind !== 'definitions' && !shortItem(item.text))) continue;
    const { key, kind } = item.group;
    let kinds = members.get(key);
    if (!kinds) members.set(key, (kinds = new Map()));
    let group = kinds.get(kind);
    if (!group) kinds.set(kind, (group = []));
    group.push(item);
    itemGroups.set(item, group);
  }
  const fits = (group, lines) => group.length <= lines &&
    group.reduce((n, item) => n + item.text.length, 0) <= maxChars &&
    group.reduce((n, item) => n + estimatedTokens(item.text), 0) <= maxTokens;
  const totals = new Map();
  const texts = new Map();
  for (const item of contextItems) {
    if (!item.group || (item.group.kind !== 'definitions' && !shortItem(item.text))) continue;
    const group = members.get(item.group.key)?.get(item.group.kind);
    if (!group) continue;
    if (!totals.has(group)) { totals.set(group, []); texts.set(group, new Set()); }
    if (!texts.get(group).has(item.text)) {
      totals.get(group).push(item);
      texts.get(group).add(item.text);
    }
  }
  for (const [item, group] of itemGroups) {
    // 説明文を開くdetailsの要約1つは本文。ナビ・リストなどのラベルは1つ残った場合も本文に混ぜない。
    if (item.group.kind === 'disclosure' && (totals.get(group)?.length ?? group.length) < 2) itemGroups.delete(item);
  }
  // 本文・同種の項目をそれぞれ詰め、組の先頭の優先順で送り出す。間に別の種類があっても小さい組を乱立させない。
  const planned = new Map();
  const register = (group) => { for (const item of group) planned.set(item, group); };
  for (const group of chunk(items.filter((item) => !itemGroups.has(item)), { maxLines, maxChars })) {
    register(group);
  }
  const byKind = new Map();
  for (const item of items) {
    const group = itemGroups.get(item);
    if (!group) continue;
    // 定義の組も、本文のプロパティ説明とナビのリンク集は別の依頼にする。
    const kind = item.group.kind === 'definitions' ? `definitions:${item.group.scope ?? 'body'}` : item.group.kind;
    if (!byKind.has(kind)) byKind.set(kind, new Set());
    byKind.get(kind).add(group);
  }
  for (const groups of byKind.values()) {
    let current = [];
    const flush = () => { if (current.length) register(current); current = []; };
    for (const group of groups) {
      if (group[0].group.kind === 'definitions') {
        const large = !fits(totals.get(group) ?? group, maxGroupLines);
        if (large) flush();
        const units = new Map();
        const ordered = [...group].sort((a, b) => (a.group.order ?? 0) - (b.group.order ?? 0));
        for (const item of ordered) {
          const key = item.group.unit;
          if (!units.has(key)) units.set(key, []);
          units.get(key).push(item);
        }
        for (const unit of units.values()) {
          if (current.length && !fits([...current, ...unit], maxGroupLines)) flush();
          current.push(...unit);
          // 1組だけで予算を超える場合もdt/ddを分けず、他の組を足さずに送る。
          if (current.length >= maxLines || !fits(current, maxGroupLines)) flush();
        }
        if (large) flush();
        continue;
      }
      if (fits(totals.get(group) ?? group, maxGroupLines)) {
        if (!fits([...current, ...group], maxGroupLines)) flush();
        current.push(...group);
        if (current.length >= maxLines) flush();
      } else {
        flush();
        let part = [];
        for (const member of group) {
          if (part.length && !fits([...part, member], maxLines)) {
            register(part);
            part = [];
          }
          part.push(member);
        }
        if (part.length) register(part);
      }
    }
    flush();
  }
  const result = [];
  const done = new Set();
  for (const item of items) {
    if (done.has(item)) continue;
    const group = planned.get(item);
    result.push(group);
    for (const member of group) done.add(member);
  }
  return result;
}

/**
 * 生成が止まらなくなったか（同じ並びの繰り返し、送った行数より多い行）。止まらなくなった長さを返す（0 なら続ける）。
 * 末尾が、長さ p の同じ並びの3回の繰り返しになっていれば止める（短い並びは、3回で24字以上のときだけ見る）。
 * ただし、訳文が原文の字数（sourceChars）の1.2倍＋16字を超えるまでは、繰り返しでは止めない。原文にもともと繰り返しがある
 * （「min min min…」「Copied Copied…」など表の単位やボタンが並ぶ）と、正しい訳文も繰り返しになるため
 * （2026-11-09、作者の Brave で「min」「コピー済み」の並びを打ち切っていた）。止まらなくなった生成は原文よりずっと長くなる。
 * 繰り返しではない写し（CSS をそのまま写すなど）は見つけられないので、段落の集め方で防ぐ（worthTranslating）。
 * 行の出しすぎは、まとめ訳し（2行以上）だけで見る。1段落の訳はモデルが複数行に分けて返しうるので、行数で切ると
 * 2行目以降の文が黙って抜ける（2026-11-13）。1段落の生成の長さは生成の上限（shared/prompt.js の maxTokensFor）が抑える。
 */
export function runaway(text, lines, sourceChars = 0) {
  if (lines > 1 && text.split('\n').length > lines + 1) return text.split('\n').slice(0, lines).join('\n').length;
  if (text.length <= sourceChars * 1.2 + 16) return 0;
  for (let p = 2; p <= 150 && p * 3 <= text.length; p++) {
    if (p * 3 < 24) continue;
    const a = text.slice(-p);
    if (text.slice(-2 * p, -p) === a && text.slice(-3 * p, -2 * p) === a) return text.length - 2 * p;
  }
  return 0;
}

/** サイトの単位（登録ドメインの近似）。github.com・docs.github.com → github.com、www.example.co.jp → example.co.jp。 */
export function siteOf(host) {
  const labels = host.split('.');
  if (labels.length <= 2 || /^\d+$/.test(labels.at(-1))) return host; // IPアドレス・localhost など
  const secondLevel = labels.at(-1).length === 2 && /^(co|ne|or|ac|go|ed|gr|lg|com|net|org|edu|gov)$/.test(labels.at(-2));
  return labels.slice(secondLevel ? -3 : -2).join('.');
}
