// PDF翻訳のページの Worker。PDFium・harfbuzz・pdf-lib の重い処理（段落の読み取り、ページの書き込み、保存）を画面の外で行い、
// 数百ページの PDF でも画面の操作を止めない。翻訳は Worker から頼めない（chrome.* が無い）ので、画面に頼んで結果を受け取る。
//
// 画面 → Worker：{ type: 'open', bytes }・{ type: 'start', parallel }（中止した後は続きから）・{ type: 'stop' }・{ type: 'focus', page }・
//   { type: 'partial', id, lines }・{ type: 'translated', id, results | error }・{ type: 'save' }
// Worker → 画面：{ type: 'opened', paragraphs }・{ type: 'translate', id, texts }・{ type: 'status', list, status }・
//   { type: 'preview', list }・{ type: 'fonts' }・{ type: 'version', bytes, pages }・{ type: 'titles', entries }・{ type: 'stage', stage, done, total }・
//   { type: 'done', stats }・{ type: 'saved', result }・{ type: 'error', during, message }
import { openPdfJob } from './translate.js';

let job = null;
let focus = 0;
let seq = 0;
const waiting = new Map();

/** 画面へ渡す段落の位置・色・書式と、確定した段落の訳文。 */
const brief = (p, status) => ({
  id: p.id, page: p.page, geometry: p.geometry, background: p.background, color: p.color,
  pieces: status === 'done' ? p.pieces : [],
});

function translate(texts, signal, onPartial) {
  const id = ++seq;
  const abort = () => waiting.get(id)?.reject(signal.reason);
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, onPartial });
    signal.addEventListener('abort', abort, { once: true });
    postMessage({ type: 'translate', id, texts });
  }).finally(() => {
    waiting.delete(id);
    signal.removeEventListener('abort', abort);
  });
}

async function start(parallel) {
  try {
    const stats = await job.run({
      translate, parallel,
      focus: () => focus,
      onStage: (stage) => postMessage({ type: 'stage', ...stage }),
      onStatus: (list, status) => { if (list.length) postMessage({ type: 'status', list: list.map((p) => brief(p, status)), status }); },
      onPreview: (list) => postMessage({ type: 'preview', list }),
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
      job = await openPdfJob(m.bytes, {
        onFontProgress: (done, total) => postMessage({ type: 'stage', stage: 'font', done, total }),
        onFontsReady: () => postMessage({ type: 'fonts' }),
      });
      postMessage({ type: 'opened', paragraphs: job.paras.filter((p) => !p.skip).length });
    } else if (m.type === 'start') start(m.parallel);
    else if (m.type === 'stop') job?.stop();
    else if (m.type === 'focus') focus = m.page;
    else if (m.type === 'partial') waiting.get(m.id)?.onPartial(m.lines);
    else if (m.type === 'translated') {
      const w = waiting.get(m.id);
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
