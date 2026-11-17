// PDF翻訳のページの Worker。PDFium・harfbuzz・pdf-lib の重い処理（段落の読み取り、ページの書き込み、保存）を画面の外で行い、
// 数百ページの PDF でも画面の操作を止めない。翻訳は Worker から頼めない（chrome.* が無い）ので、画面に頼んで結果を受け取る。
//
// 画面 → Worker：{ type: 'open', bytes }・{ type: 'start' }（中止した後は続きから）・{ type: 'stop' }・{ type: 'focus', page }・
//   { type: 'translated', id, results | error }・{ type: 'save' }
// Worker → 画面：{ type: 'opened', paragraphs }・{ type: 'translate', id, texts }・{ type: 'status', list, status }・
//   { type: 'version', bytes, pages }・{ type: 'titles', entries }・{ type: 'stage', stage, done, total }・
//   { type: 'done', stats }・{ type: 'saved', result }・{ type: 'error', during, message }
import { paragraphBox } from './plan.js';
import { openPdfJob } from './translate.js';

let job = null;
let focus = 0;
let seq = 0;
const waiting = new Map();

/** 画面へ渡す段落の要約（半透明の表示を置く位置と色）。 */
const brief = (p) => ({ id: p.id, page: p.page, box: paragraphBox(p), background: p.background ?? null });

function translate(texts) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    postMessage({ type: 'translate', id, texts });
  });
}

async function start() {
  try {
    const stats = await job.run({
      translate,
      focus: () => focus,
      onStage: (stage) => postMessage({ type: 'stage', ...stage }),
      onStatus: (list, status) => { if (list.length) postMessage({ type: 'status', list: list.map(brief), status }); },
      onVersion: ({ bytes, pages }) => postMessage({ type: 'version', bytes, pages }, [bytes.buffer]),
      onTitles: (titles) => { if (titles.size) postMessage({ type: 'titles', entries: [...titles] }); },
    });
    postMessage({ type: 'done', stats });
  } catch (e) {
    postMessage({ type: 'error', during: 'translate', message: e.message });
  }
}

onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'open') {
      job = await openPdfJob(m.bytes, { onFontProgress: (done, total) => postMessage({ type: 'stage', stage: 'font', done, total }) });
      postMessage({ type: 'opened', paragraphs: job.paras.filter((p) => !p.skip).length });
    } else if (m.type === 'start') start();
    else if (m.type === 'stop') job?.stop();
    else if (m.type === 'focus') focus = m.page;
    else if (m.type === 'translated') {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w?.reject(new Error(m.error));
      else w?.resolve(m.results);
    } else if (m.type === 'save') {
      const result = await job.save();
      postMessage({ type: 'saved', result }, [result.bytes.buffer]);
    }
  } catch (e) {
    postMessage({ type: 'error', during: m.type, message: e.message });
  }
};
