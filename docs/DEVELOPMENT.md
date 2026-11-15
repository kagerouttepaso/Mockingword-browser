# 開発・配布手順

更新日：2026-11-15

## 通常の開発

Node.js 24以上とPython 3.10以上を使います。実行コマンドはリポジトリ直下から指定します。通常の拡張機能の読み込みにはビルド不要です。

```powershell
npm test
$env:BROWSER = '<Chrome for TestingまたはBraveの実行ファイル>'
npm run test:e2e
python tools/package.py
```

通常版Chromeはコマンドラインからの拡張読み込みを制限するため、自動試験は公式 [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) またはBraveを使います。手動での読み込みはREADMEの手順です。

試験は新しい一時プロファイルを作ります。モデルのバイトはリポジトリ外の共有キャッシュを使い、試験時だけ固定URLへの要求に応答します。本番の拡張機能にはこの試験用サーバーを含めません。モデルは初回だけ取得します。

## WASMを再ビルドする

Docker Desktop、Git、Node.js、固定した`tools/wllama/pins.json`を使います。作業領域はリポジトリ外へ置きます。

```powershell
node tools/wllama/build.mjs --variant baseline --patches tools/wllama/patches/commands,tools/wllama/patches/sampling,tools/wllama/patches/matmul,tools/wllama/patches/result,tools/wllama/patches/prefill,tools/wllama/patches/matmul-h8,tools/wllama/patches/attn,tools/wllama/patches/prefill-m8,tools/wllama/patches/sampling-stable
```

生成物のJS・WASMを同じbuild manifestから一組で差し替え、SHA-256と固定入力をvendor READMEへ記録します。詳細は [ビルドと計測](08_wllamaビルドと計測.md)。

## 申請ZIP

`python tools/package.py`は`dist/Mockingword-<version>.zip`とSHA-256ファイルを作ります。manifestはZIPの直下に置き、モデル、ログ、個人設定、開発ツール、Git履歴は含めません。`store/`の掲載画像・文面はZIPとは別に申請画面へ渡します。

## アイコン

Android版のVectorDrawableを`artwork/android/`へ取り込み、同じパスと色をSVGへ変換した`artwork/icon.svg`を各サイズへ描画します。図柄を新たに描き直していません。Android側の参照元とコミットは`artwork/SOURCE.md`。

## デザインの更新

`artwork/design-tokens.json`をAndroidのTheme.ktと照合して更新し、`node tools/sync-design.mjs`で共通CSSと2種類のJSを再生成します。`node tools/sync-design.mjs --check`で一致を確認できます。色と役割・アイコンの正本は[デザイン言語](デザイン言語.md)。

## 利用者へ更新を渡すとき

manifest.jsonとpackage.jsonの版をそろえて上げる。同じ版を何度も差し替えない。画面の版表示、実際のツールバーメニュー、拡張を更新した前から開いているページ、未翻訳のページでの開始を確認する。アイコンだけを描画する場合は`node tools/icons.mjs`を使う。
