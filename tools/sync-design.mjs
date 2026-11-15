// Androidから取り込んだ色の正本から、通常CSS・ES module・content scriptを同時に更新する。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(fs.readFileSync(path.join(root, 'artwork/design-tokens.json'), 'utf8'));
const vars = kind => Object.entries(tokens[kind]).map(([role, value]) => {
  if (!/^#[A-Fa-f0-9]{6}$/.test(value)) throw new Error('Invalid color');
  return `--mw-${role.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}:${value}`;
}).join(';') + `;--mw-color-scheme:${kind};`;
const manual = kind => `:root[data-mw-theme="${kind}"],:host([data-mw-theme="${kind}"]),.plamo-ui[data-mw-theme="${kind}"]{${vars(kind)}}`;
const css = `/* Android版Theme.ktの役割と色から生成。 */\n:root,:host,.plamo-ui{${vars('light')}}\n@media(prefers-color-scheme:dark){:root,:host,.plamo-ui{${vars('dark')}}}\n${manual('light')}\n${manual('dark')}\n`;
const outputs = {
  'extension/shared/theme.css': css,
  'extension/shared/theme.js': '// 生成物。正本はartwork/design-tokens.json。\nexport const themeCss = ' + JSON.stringify(css) + ';\n',
  'extension/shared/theme-watch.js': '// importできないcontent script用の生成物。\nglobalThis.__mockingwordThemeCss = ' + JSON.stringify(css) + ';\n',
};
for (const [name, content] of Object.entries(outputs)) {
  const file = path.join(root, name);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) throw new Error(`Generated file is stale: ${name}`);
  } else fs.writeFileSync(file, content);
}
console.log(process.argv.includes('--check') ? 'Design tokens verified' : 'Design tokens generated');
