"""申請ZIPをextensionの許可済みファイルだけから作る（Python標準ライブラリ）。"""
from pathlib import Path
import hashlib, json, zipfile

root = Path(__file__).resolve().parents[1]
extension = root / 'extension'
manifest = json.loads((extension / 'manifest.json').read_text('utf-8'))
if manifest['version'] != json.loads((root / 'package.json').read_text('utf-8'))['version']:
    raise SystemExit('manifest.jsonとpackage.jsonの版が一致しません')
allowed = {'background': {'.js'}, 'core': {'.js'}, 'offscreen': {'.js', '.html'},
           'page': {'.js', '.css'}, 'shared': {'.js', '.css'}, 'ui': {'.js', '.css', '.html'},
           'icons': {'.png'}, 'licenses': {'.txt'}}
files = []
for item in sorted(extension.rglob('*')):
    if item.is_symlink(): raise SystemExit('配布物にシンボリックリンクを含められません')
    if not item.is_file(): continue
    rel = item.relative_to(extension)
    if rel.as_posix() == 'vendor/wllama/README.md': continue
    if rel.as_posix() in ('manifest.json', 'vendor/wllama/index.js', 'vendor/wllama/wasm/wllama.wasm'):
        files.append(item); continue
    if len(rel.parts) != 2 or rel.parts[0] not in allowed or item.suffix not in allowed[rel.parts[0]]:
        raise SystemExit(f'未確認のファイルがextensionにあります: {rel}')
    files.append(item)
for name in ('Mockingword-MIT.txt', 'PLaMo-Community-License.txt', 'wllama-MIT.txt', 'llama.cpp-MIT.txt', 'sakutto-MIT.txt'):
    if not (extension / 'licenses' / name).is_file(): raise SystemExit(f'ライセンスがありません: {name}')
out = root / 'dist'; out.mkdir(exist_ok=True)
archive = out / f'Mockingword-{manifest["version"]}.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for item in files:
        info = zipfile.ZipInfo(item.relative_to(extension).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        z.writestr(info, item.read_bytes())
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    assert 'manifest.json' in z.namelist()
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(out / (archive.name + '.sha256')).write_text(f'{digest}  {archive.name}\n', 'utf-8')
print(json.dumps({'file': str(archive), 'files': len(files), 'bytes': archive.stat().st_size, 'sha256': digest}))
