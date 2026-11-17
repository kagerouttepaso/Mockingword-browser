# 第三者ライセンス

MockingwordはPreferred Networksの公式製品ではありません。PLaMo™はPreferred Networksの商標です。

| 対象 | 版・取得元 | 条件と同梱本文 |
| --- | --- | --- |
| wllama | 3.13.0、6647c1ea3837b2f0205a300c3bf5ff644aaa06bf | MIT、[本文](extension/licenses/wllama-MIT.txt) |
| llama.cpp | 7d7f0287530bc8981690f361d8c1627dbae1c99a | MIT、[本文](extension/licenses/llama.cpp-MIT.txt) |
| sakuttoのビルド設計・取得再試行の参考部分 | jammaru/sakutto | MIT、[本文](extension/licenses/sakutto-MIT.txt) |
| pdf.js（pdfjs-dist） | 4.10.38 | Apache-2.0、[本文](extension/licenses/pdfjs-Apache-2.0.txt) |
| PDFium | @embedpdf/pdfium 2.15.1 に同梱 | BSD、[本文](extension/licenses/PDFium-BSD.txt) |
| @embedpdf/pdfium | 2.15.1 | MIT、[本文](extension/licenses/embedpdf-pdfium-MIT.txt) |
| pdf-lib | 1.17.1 | MIT、[本文](extension/licenses/pdf-lib-MIT.txt) |
| harfbuzzjs（hb-subset） | 1.6.4 | MIT、[本文](extension/licenses/harfbuzzjs-MIT.txt) |
| Noto Sans JP（PDF翻訳の訳文） | @expo-google-fonts/noto-sans-jp 0.4.4 をjsDelivrから取得（同梱しない） | [SIL Open Font License 1.1](https://openfontlicense.org/)。訳したPDFへ使った文字だけを埋め込む |
| PLaMo 3 Translate（0.8B・2B） | pfnetの公式GGUFをコミット固定URLで取得 | [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja)、[同梱の写し](extension/licenses/PLaMo-Community-License.txt) |

Built with PLaMo

モデルはZIPへ同梱せず、利用者のブラウザーが公式配布元から取得します。個人・非商用と商用・業務で利用条件が異なります。最新の条文を確認してください。モデル名はPLaMo 3 Translateのまま表示します。

WASMは自前パッチを含みます。[固定入力とビルド手順](extension/vendor/wllama/README.md)・[パッチの出典](tools/wllama/licenses/README.md)。

訳文などの生成物を用いてAIモデルを学習した場合、そのモデルにはPLaMo Community Licenseが適用されます（第4条）。モデルの学習や生成物の再提供を行うときは条文の条件を確認してください。
