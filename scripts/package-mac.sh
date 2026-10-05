#!/bin/sh
# Mac 用の配布ファイル（.dmg）を作る。
# Tauri の dmg 作成は Finder を操作するため、環境によっては失敗する。
# ここではアプリだけを作り、hdiutil で「アプリ＋アプリケーションフォルダへのリンク」だけの dmg を作る。
set -e
cd "$(dirname "$0")/.."
npx tauri build --bundles app
APP="src-tauri/target/release/bundle/macos/ひだまり村.app"
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
OUT="src-tauri/target/release/bundle/hidamari-village_${VERSION}_mac.dmg"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -volname "ひだまり村" -srcfolder "$STAGE" -ov -format UDZO "$OUT" >/dev/null
rm -rf "$STAGE"
echo "できました: $OUT"
