#!/usr/bin/env bash
# 把本地 MV Studio 安裝包放進下載頁，並產生 SHA-256 與版本資訊
# 用法：bash scripts/build-download.sh <memory-mv-studio.zip 路徑> [版本號]
# 預設路徑：../dist/memory-mv-studio.zip（MV/cloud 與 MV/dist 並列時）
set -euo pipefail
cd "$(dirname "$0")/.."
ZIP="${1:-/Users/dreamgen/StudioProjects/MV/dist/memory-mv-studio.zip}"
VER="${2:-$(date +%Y.%m.%d)}"
if [ ! -f "$ZIP" ]; then
  echo "找不到安裝包：$ZIP" >&2
  exit 1
fi
mkdir -p public/download
cp "$ZIP" public/download/memory-mv-studio.zip
if command -v sha256sum >/dev/null; then
  SHA=$(sha256sum public/download/memory-mv-studio.zip | cut -d' ' -f1)
else
  SHA=$(shasum -a 256 public/download/memory-mv-studio.zip | cut -d' ' -f1)
fi
SIZE=$(wc -c < public/download/memory-mv-studio.zip | tr -d ' ')
cat > public/download/latest.json <<JSON
{"file":"memory-mv-studio.zip","version":"$VER","sha256":"$SHA","size":$SIZE,"built_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
echo "已更新下載頁：版本 ${VER}，SHA-256 ${SHA}"
echo "記得重新部署：bash scripts/deploy.sh"
