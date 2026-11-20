#!/usr/bin/env bash
# 部署腳本：隨身閱讀 PocketReader Cloudflare Worker + R2
set -euo pipefail

cd "$(dirname "$0")/.."
BUCKET="pocket-reader-data"

echo "==> 檢查 Cloudflare 登入狀態"
if ! npx wrangler whoami 2>&1 | grep -qiE "You are logged in|associated with the email"; then
  echo "尚未登入 Cloudflare，請先執行："
  echo "    npx wrangler login"
  exit 1
fi

echo "==> 檢查 R2 bucket：$BUCKET"
if npx wrangler r2 bucket list 2>/dev/null | grep -qE "^name:\s+$BUCKET\s*$"; then
  echo "bucket 已存在"
else
  echo "建立 bucket $BUCKET"
  npx wrangler r2 bucket create "$BUCKET"
fi

echo "==> 部署 Worker"
npx wrangler deploy

echo
echo "部署完成！請將上方輸出的 *.workers.dev 網址填入 pocketReader/config.js 的 workerUrl，或在 App 設定頁直接貼上。"
