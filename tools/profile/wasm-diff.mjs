// WASM の section と関数本体を比較する。意味の同等性はソース・実行結果と合わせて判断する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, readArgs } from '../wllama/support.mjs';

function reader(buffer, start = 0) {
  return { position: start,
    byte() { if (this.position >= buffer.length) throw new Error('WASM の終端を超えました'); return buffer[this.position++]; },
    uint() { let value = 0, shift = 0, byte; do { byte = this.byte(); value += (byte & 127) * 2 ** shift; shift += 7; if (shift > 56) throw new Error('LEB128 が長すぎます'); } while (byte & 128); return value; },
    string() { const size = this.uint(); const value = buffer.toString('utf8', this.position, this.position + size); this.position += size; return value; },
  };
}
function parse(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '0061736d01000000') throw new Error('WASM header が不正です');
  const r = reader(buffer, 8), sections = [];
  while (r.position < buffer.length) {
    const id = r.byte(), size = r.uint(), start = r.position;
    const name = id === 0 ? r.string() : '';
    if (start + size > buffer.length) throw new Error('WASM section の長さが不正です');
    sections.push({ id, name, start, dataStart: r.position, end: start + size, size,
      sha256: sha256(buffer.subarray(start, start + size)) });
    r.position = start + size;
  }
  let importedFunctions = 0;
  const imports = sections.find((section) => section.id === 2);
  if (imports) {
    const ir = reader(buffer, imports.start), count = ir.uint();
    const limits = () => { const flags = ir.uint(); ir.uint(); if (flags & 1) ir.uint(); };
    const valueType = () => { const type = ir.byte(); if (type === 0x63 || type === 0x64) ir.uint(); };
    for (let i = 0; i < count; ++i) {
      ir.string(); ir.string();
      const kind = ir.byte();
      if (kind === 0) { ir.uint(); ++importedFunctions; }
      else if (kind === 1) { valueType(); limits(); }
      else if (kind === 2) limits();
      else if (kind === 3) { valueType(); ir.byte(); }
      else if (kind === 4) { ir.byte(); ir.uint(); }
      else throw new Error(`未対応の WASM import kind: ${kind}`);
    }
  }
  const names = new Map();
  const nameSection = sections.find((section) => section.id === 0 && section.name === 'name');
  if (nameSection) {
    const nr = reader(buffer, nameSection.dataStart);
    while (nr.position < nameSection.end) {
      const id = nr.byte(), size = nr.uint(), end = nr.position + size;
      if (id === 1) { const count = nr.uint(); for (let i = 0; i < count; ++i) { const index = nr.uint(); names.set(index, nr.string()); } }
      nr.position = end;
    }
  }
  const code = sections.find((section) => section.id === 10), functions = [];
  if (code) {
    const cr = reader(buffer, code.start), count = cr.uint();
    for (let i = 0; i < count; ++i) {
      const size = cr.uint(), index = importedFunctions + i;
      functions.push({ index, name: names.get(index) ?? `function${index}`, body: buffer.subarray(cr.position, cr.position + size) });
      cr.position += size;
    }
    if (cr.position !== code.end) throw new Error('WASM code section の長さが不正です');
  }
  return { sections, functions };
}
export function compareWasm(reference, candidate) {
  const a = parse(reference), b = parse(candidate);
  const changedFunctions = [];
  for (let i = 0; i < Math.max(a.functions.length, b.functions.length); ++i) {
    const left = a.functions[i], right = b.functions[i];
    if (left?.body.equals(right?.body ?? Buffer.alloc(0))) continue;
    const ranges = [];
    for (let offset = 0; offset < Math.max(left?.body.length ?? 0, right?.body.length ?? 0); ++offset) {
      if (left?.body[offset] === right?.body[offset]) continue;
      if (ranges.at(-1)?.end === offset) ranges.at(-1).end = offset + 1;
      else ranges.push({ start: offset, end: offset + 1 });
    }
    changedFunctions.push({ index: left?.index ?? right.index, name: left?.name ?? right.name,
      referenceBytes: left?.body.length ?? 0, candidateBytes: right?.body.length ?? 0, ranges });
  }
  return { identical: reference.equals(candidate), referenceSha256: sha256(reference), candidateSha256: sha256(candidate),
    sections: Array.from({ length: Math.max(a.sections.length, b.sections.length) }, (_, i) => ({ id: a.sections[i]?.id ?? b.sections[i].id,
      name: a.sections[i]?.name ?? b.sections[i].name, referenceBytes: a.sections[i]?.size ?? null, candidateBytes: b.sections[i]?.size ?? null,
      identical: a.sections[i]?.sha256 === b.sections[i]?.sha256 })), changedFunctions };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = readArgs(process.argv.slice(2), { '--reference': 'value', '--candidate': 'value' });
    if (!args.reference || !args.candidate) throw new Error('--reference FILE --candidate FILE を指定してください');
    console.log(JSON.stringify(compareWasm(fs.readFileSync(args.reference), fs.readFileSync(args.candidate)), null, 2));
  } catch (e) { console.error(e.stack); process.exitCode = 1; }
}
