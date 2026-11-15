// 候補適用後の実際のAPI呼出しを計測する。helperの呼出し側を重ねて数えない。
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; ++i) { if (text[i] === '(') ++depth; if (text[i] === ')' && --depth === 0) return i; }
  throw new Error('WebGPUの呼出し括弧が閉じていません');
}
function argumentsOf(text) {
  const result = []; let depth = 0, start = 0;
  for (let i = 0; i < text.length; ++i) { if ('([{'.includes(text[i])) ++depth; if (')]}'.includes(text[i])) --depth; if (text[i] === ',' && depth === 0) { result.push(text.slice(start, i).trim()); start = i + 1; } }
  result.push(text.slice(start).trim()); return result;
}
function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`計測のアンカーが一致しません: ${before.slice(0, 90)}`);
  return text.replace(before, after);
}
export function instrumentWebGpu(input) {
  if (input.includes('plamo_profile::')) throw new Error('WebGPUは計測済みです。候補を先に適用してください');
  let text = '#include "../../../../cpp/plamo-profile.h"\n' + input;
  for (const [name, metric] of [['ggml_backend_webgpu_map_buffer', 'map_wait'], ['ggml_backend_webgpu_build_multi', 'build'], ['ggml_backend_webgpu_device_event_synchronize', 'event_wait'], ['ggml_backend_webgpu_buffer_get_tensor', 'tensor_read'], ['ggml_backend_webgpu_buffer_get_tensor_n', 'tensor_read']]) {
    const pattern = new RegExp('static [^\\n]* ' + name + '\\([^;]*?\\) \\{');
    const found = text.match(pattern);
    if (!found) throw new Error(`計測対象の関数が見つかりません: ${name}`);
    text = text.replace(found[0], found[0] + `\n    plamo_profile::Scope plamo_scope(plamo_profile::${metric});`);
  }
  // commands-3の早期returnとmutex取得より後に置き、実際に待った回数を数える。
  text = replaceOnce(text, '    wgpu::QueueWorkDoneStatus callback_status =', '    plamo_profile::Scope plamo_scope(plamo_profile::queue_wait);\n    wgpu::QueueWorkDoneStatus callback_status =');
  const counts = { bind_group: 0, write_buffer: 0, submit: 0, host_copy: 0 };
  const replacements = [];
  for (const match of text.matchAll(/[A-Za-z_]\w*(?:(?:->|\.)[A-Za-z_]\w*)*\.(WriteBuffer|CreateBindGroup|Submit)\(/g)) {
    const open = match.index + match[0].length - 1, end = closing(text, open), expression = text.slice(match.index, end + 1);
    const metric = { WriteBuffer: 'write_buffer', CreateBindGroup: 'bind_group', Submit: 'submit' }[match[1]];
    const args = argumentsOf(text.slice(open + 1, end));
    const bytes = metric === 'write_buffer' ? args[3] : '0';
    if (!bytes) throw new Error('WriteBufferのバイト数を特定できません');
    counts[metric]++;
    replacements.push([match.index, end + 1, `plamo_profile::call(plamo_profile::${metric}, ${bytes}, [&]() { return ${expression}; })`]);
  }
  for (const [start, end, replacement] of replacements.reverse()) text = text.slice(0, start) + replacement + text.slice(end);
  const copies = [];
  for (const match of text.matchAll(/std::memcpy\(data(?:\[i\])?,/g)) {
    const open = text.indexOf('(', match.index), end = closing(text, open), args = argumentsOf(text.slice(open + 1, end));
    counts.host_copy++;
    copies.push([match.index, end + 1, `plamo_profile::call(plamo_profile::host_copy, ${args[2]}, [&]() { return ${text.slice(match.index, end + 1)}; })`]);
  }
  for (const [start, end, replacement] of copies.reverse()) text = text.slice(0, start) + replacement + text.slice(end);
  text = replaceOnce(text, '        ctx->shader_gpu_time_ms[pipeline_names[i]] += elapsed_ms;', '        ctx->shader_gpu_time_ms[pipeline_names[i]] += elapsed_ms;\n        plamo_profile::gpu(pipeline_names[i].c_str(), elapsed_ms);');
  if (Object.values(counts).some((count) => count === 0)) throw new Error('必要なWebGPU計測点が欠落しています');
  return { source: text, counts };
}
