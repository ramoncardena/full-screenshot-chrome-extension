#!/usr/bin/env bash
# Builds dist/full-screenshot-chrome-extension-<version>.zip, ready for the Chrome Web Store
# or for sharing and installing with "Load unpacked".
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
out="dist/full-screenshot-chrome-extension-${version}.zip"

mkdir -p dist
rm -f "$out"
zip -qr "$out" \
  manifest.json \
  background.js \
  content.js \
  storage.js \
  editor.html \
  editor.js \
  icons

echo "Built $out"
unzip -l "$out"
