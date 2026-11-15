// PFML3 のプロンプトの組み立て。手本は Androidアプリの Pfml3PromptBuilder.kt。
// チャットテンプレートは使わず、改行を入れずに1行につなぐ。温度0、STOP のどちらかで止める。

const MARK = '<|plamo:';
export const STOP = ['<|plamo:tag|>', '<|plamo:bos|>'];

/** 原文に区切り文字列が混ざるとプロンプトが壊れるので取り除く。 */
function sanitize(text) {
  return text.split(MARK).join('').trim();
}

/** source が null なら input に lang を書かず、原文の言語をモデルに判定させる（画面翻訳と同じ）。 */
export function buildPrompt(text, { source = null, target = 'ja', form = 'polite', context = null } = {}) {
  let p = '<|plamo:tag|>dataset<|plamo:msg|>translation';
  if (context && context.trim()) p += '<|plamo:tag|>context<|plamo:msg|>' + sanitize(context);
  p += '<|plamo:tag|>input';
  if (source) p += '<|plamo:key|>lang<|plamo:val|>' + source;
  p += '<|plamo:msg|>' + sanitize(text);
  p += '<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>' + target;
  if (target === 'ja') p += '<|plamo:key|>form<|plamo:val|>' + form;
  return p + '<|plamo:msg|>';
}

/**
 * 生成の上限。日本語の訳文は原文とほぼ同じ字数かそれより短く、1字はおよそ1トークン以下なので、字数の1.5倍で足りる。
 * 止まらなくなったときに長く出し続けないよう、低めにしておく（以前は3倍・最大3072）。
 */
export function maxTokensFor(text) {
  return Math.min(1536, 48 + Math.ceil(text.length * 1.5));
}
