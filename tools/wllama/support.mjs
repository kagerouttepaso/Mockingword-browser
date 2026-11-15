import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RECIPE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT = path.resolve(RECIPE, '../..');
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const hashFile = (file) => sha256(fs.readFileSync(file));
export function workRoot(value) {
  const root = path.resolve(value ?? process.env.PLAMO_BUILD_ROOT ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'plamo-translate-build'));
  let repository = PROJECT;
  for (let folder = PROJECT; ; folder = path.dirname(folder)) {
    if (fs.existsSync(path.join(folder, '.git'))) { repository = folder; break; }
    if (path.dirname(folder) === folder) break;
  }
  const rel = path.relative(repository, root);
  if (!rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) throw new Error('WORK はリポジトリの外に置いてください');
  return root;
}
export function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`作業領域の子フォルダーを指定してください: ${target}`);
  return target;
}
export function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + `.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}
export function run(command, args, { cwd, env, capture = false, log, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env: env ?? process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let tail = '';
    for (const [stream, dest] of [[proc.stdout, process.stdout], [proc.stderr, process.stderr]]) {
      stream.on('data', (chunk) => {
        tail = (tail + chunk).slice(-12000);
        if (capture && stream === proc.stdout) out += chunk;
        else dest.write(chunk);
        log?.write(chunk);
        onOutput?.(chunk.toString());
      });
    }
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`${command} ${args.join(' ')} が終了コード ${code} で失敗しました\n${tail}`)));
  });
}
export function readArgs(argv, allowed) {
  const args = {};
  for (let i = 0; i < argv.length; ++i) {
    const key = argv[i];
    if (!Object.hasOwn(allowed, key)) throw new Error(`不明な引数: ${key}`);
    if (allowed[key] === 'flag') args[key.slice(2)] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${key} の値が必要です`);
      args[key.slice(2)] = argv[++i];
    }
  }
  return args;
}
