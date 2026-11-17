// フォントを使った文字だけに減らす（harfbuzz の hb-subset、WASM）。PDF に丸ごと埋め込むと1書体で約5.7MB増えるため。
// 呼び出しは harfbuzzjs の subset-font と同じ手順（入力の文字集合だけを指定し、ほかは既定）。PDF の中のフォントを差し替えるときは
// 字形の番号を保つ（RETAIN_GIDS）。PDFium が書く日本語の文字は字形の番号そのもの（Identity-H、CIDToGIDMap なし）なので、
// 番号を詰めると別の字形になる。

let ready = null;
const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_FLAGS_RETAIN_GIDS = 0x2;

function harfbuzz() {
  ready ??= (async () => {
    const binary = await (await fetch(new URL('../vendor/harfbuzz/harfbuzz-subset.wasm', import.meta.url))).arrayBuffer();
    const { instance } = await WebAssembly.instantiate(binary);
    instance.exports._initialize();
    return instance.exports;
  })();
  return ready;
}

/** TrueType のバイト列から、text に含まれる文字だけのフォントを作る。retainGids なら字形の番号を元のまま保つ。 */
export async function subsetFont(bytes, text, { retainGids = false } = {}) {
  const hb = await harfbuzz();
  const heap = () => new Uint8Array(hb.memory.buffer); // 処理中にメモリーが伸びると前の参照が無効になるので、使うたびに取り直す
  const font = new Uint8Array(bytes);
  const input = hb.hb_subset_input_create_or_fail();
  if (!input) throw new Error('hb_subset_input_create_or_fail に失敗しました');
  const ptr = hb.malloc(font.length);
  heap().set(font, ptr);
  const blob = hb.hb_blob_create(ptr, font.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  const unicodes = hb.hb_subset_input_unicode_set(input);
  for (const ch of new Set(text)) hb.hb_set_add(unicodes, ch.codePointAt(0));
  if (retainGids) hb.hb_subset_input_set_flags(input, hb.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_RETAIN_GIDS);
  const subset = hb.hb_subset_or_fail(face, input);
  hb.hb_subset_input_destroy(input);
  if (!subset) {
    hb.hb_face_destroy(face);
    hb.free(ptr);
    throw new Error('hb_subset_or_fail に失敗しました');
  }
  const result = hb.hb_face_reference_blob(subset);
  const offset = hb.hb_blob_get_data(result, 0);
  const length = hb.hb_blob_get_length(result);
  const out = heap().slice(offset, offset + length);
  hb.hb_blob_destroy(result);
  hb.hb_face_destroy(subset);
  hb.hb_face_destroy(face);
  hb.free(ptr);
  if (!length) throw new Error('フォントを減らせませんでした');
  return out;
}
