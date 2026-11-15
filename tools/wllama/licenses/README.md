# 出典とライセンス

| 対象 | 出典 | 本文 |
| --- | --- | --- |
| wllama 3.13.0 | https://github.com/ngxson/wllama/tree/6647c1ea3837b2f0205a300c3bf5ff644aaa06bf | wllama-MIT.txt |
| llama.cpp | https://github.com/ggml-org/llama.cpp/tree/7d7f0287530bc8981690f361d8c1627dbae1c99a | llama.cpp-MIT.txt |
| sakutto の Dawn 取得再試行とビルド設計の参考 | https://github.com/jammaru/sakutto の scripts/wllama/patches/0006-retry-dawn-download.patch、build.ts、docker.ts、artifacts.ts | sakutto-MIT.txt（Copyright (c) 2026 jammaru） |

build.mjs の Dawn 再試行は 0006 の方針を Node の取得経路へ移した。reset/clean・配布先削除・apt update・0001〜0005 は取り込んでいない。
計測パッチと計測台本は本プロジェクトで作成した。
