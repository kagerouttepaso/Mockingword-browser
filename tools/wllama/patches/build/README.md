# ビルド専用の変更

Dawn ZIP の取得は build.mjs が行い、再試行・ZIP 先頭・SHA-256 を確認する。
sakutto の 0006 をこの取得経路へ移植した。upstream の compose.yml は実行しないため、同ファイルへのパッチは重複適用しない。
帰属と MIT 本文は ../../licenses/sakutto-MIT.txt に置く。

baseline には性能を変えるパッチと計測パッチを入れない。このフォルダーの .patch は名前順で全 variant に適用する。
