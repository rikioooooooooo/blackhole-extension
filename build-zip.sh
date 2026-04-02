#!/bin/bash
# Chrome Web Store用のzipパッケージを生成
cd "$(dirname "$0")"

ZIP_NAME="blackhole-extension.zip"
rm -f "$ZIP_NAME"

# テストファイルやアセット生成ツールは除外
zip -r "$ZIP_NAME" \
  manifest.json \
  background.js \
  content.js \
  styles.css \
  icons/ \
  _locales/ \
  -x "*.git*" "test/*" "store-assets/*" "node_modules/*" "*.sh" "*.html" "*.mjs" "generate-icons.*" "PRIVACY.md" "README.md"

echo "Created: $ZIP_NAME"
echo "Size: $(du -h "$ZIP_NAME" | cut -f1)"
