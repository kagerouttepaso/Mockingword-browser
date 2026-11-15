import fs from 'node:fs';
import path from 'node:path';

export function writeChanged(file, data) {
  if (fs.existsSync(file) && fs.readFileSync(file).equals(data)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); return true;
}
export function syncBuildSources(inputRoot, sourceRoot, changedPaths, previousPaths = null) {
  const files = previousPaths === null
    ? fs.readdirSync(inputRoot, { recursive: true }).filter((file) => !file.split(path.sep).some((part) => ['.git', 'node_modules', 'build', 'build-compat', 'esm'].includes(part)) && fs.statSync(path.join(inputRoot, file)).isFile())
    : [...new Set([...previousPaths, ...changedPaths])];
  const copied = [];
  for (const file of files) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).some((part) => part === '..' || part === '.git')) throw new Error('同期対象パスが不正です');
    const input = path.join(inputRoot, file), target = path.join(sourceRoot, file);
    if (fs.existsSync(input)) { if (writeChanged(target, fs.readFileSync(input))) copied.push(file); }
    else { fs.rmSync(target, { force: true }); copied.push(file); }
  }
  return copied;
}
