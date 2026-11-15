// 公開済みdigestと照合してから、ZIP内のAPI名だけをメモリー上で調べる。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const candidate = JSON.parse(fs.readFileSync(new URL('./dawn-candidate.json', import.meta.url), 'utf8'));
export function zipText(bytes, wanted) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('ZIPの中央ディレクトリがありません');
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10), found = {};
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIPディレクトリが不正です');
    const method = bytes.readUInt16LE(offset + 10), size = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (wanted.some(suffix => name.endsWith(suffix))) {
      if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIPのファイルheaderが不正です');
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const compressed = bytes.subarray(start, start + size);
      if (method !== 0 && method !== 8) throw new Error(`未対応のZIP圧縮方式: ${method}`);
      found[name] = (method === 8 ? inflateRawSync(compressed, { maxOutputLength: 4000000 }) : compressed).toString('utf8');
    }
    offset += 46 + nameLength + extra + comment;
  }
  return found;
}
export function inspectApi(bytes) {
  const files = zipText(bytes, ['/webgpu.h', '/webgpu_cpp.h', '/library_webgpu.js', '/library_webgpu_enum_tables.js',
    '/library_webgpu_generated_struct_info.js', '/library_webgpu_generated_sig_info.js', '/webgpu-externs.js', '/README.md', '/VERSION.txt']);
  const header = Object.entries(files).filter(([name]) => /webgpu(?:_cpp)?\.h$/.test(name)).map(([, text]) => text).join('\n');
  const js = Object.entries(files).filter(([name]) => name.endsWith('.js')).map(([, text]) => text).join('\n');
  const checks = {
    matrixFeatureEnum: header.includes('ChromiumExperimentalSubgroupMatrix'),
    matrixConfigStruct: header.includes('WGPUSubgroupMatrixConfig'),
    adapterInfoChain: header.includes('WGPUAdapterPropertiesSubgroupMatrixConfigs'),
    jsFeatureName: js.includes('chromium-experimental-subgroup-matrix'),
    jsConfigProperty: js.includes('subgroupMatrixConfigs'),
    jsRequiredFeatures: js.includes('requiredFeatures'),
  };
  return { checks, apiAvailable: Object.values(checks).every(Boolean), fileNames: Object.keys(files),
    version: Object.entries(files).find(([name]) => name.endsWith('/VERSION.txt'))?.[1]?.trim(),
    requestDeviceEvidence: js.split('\n').filter(line => /requiredFeatures|subgroupMatrixConfigs/.test(line)).slice(0, 20).map(line => line.trim()),
    emsdkEvidence: Object.entries(files).filter(([name]) => name.endsWith('/README.md')).flatMap(([, text]) => text.split('\n').filter(line => /Emscripten.*\d\.\d|emsdk.*\d\.\d/.test(line))) };
}
export async function inspectCandidate(directory) {
  const result = { candidate, status: 'pending' };
  try {
    const oldFile = path.join(process.env.LOCALAPPDATA ?? '', 'plamo-translate-build', 'downloads', 'emdawn.zip');
    if (fs.existsSync(oldFile)) {
      const bytes = fs.readFileSync(oldFile);
      result.existing = { sha256: createHash('sha256').update(bytes).digest('hex'), ...inspectApi(bytes) };
    }
    const response = await fetch(candidate.url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`emdawn ZIP取得: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer()), actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== candidate.sha256) throw new Error(`emdawn ZIPのSHA-256不一致: ${actual}`);
    fs.writeFileSync(path.join(directory, 'emdawn-candidate.zip'), bytes);
    result.updated = { sha256: actual, ...inspectApi(bytes) };
    result.status = result.updated.apiAvailable ? 'api-confirmed' : 'api-incomplete';
  } catch (error) { result.status = 'inspection-incomplete'; result.error = String(error); }
  return result;
}
