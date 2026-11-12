#!/usr/bin/env bash
# 部署腳本：Cloudflare Worker（API + 靜態頁）+ R2 bucket
# 用法：bash scripts/deploy.sh
# 這個腳本會依序檢查登入、建立 R2 bucket、設定建立密碼，最後部署。
set -euo pipefail

cd "$(dirname "$0")/.."
BUCKET="mv-photo-collect"

# 1. 檢查是否已登入 Cloudflare
echo "==> 檢查 Cloudflare 登入狀態"
if ! npx wrangler whoami 2>&1 | grep -qiE "You are logged in|associated with the email"; then
  echo "尚未登入 Cloudflare，請先執行："
  echo "    npx wrangler login"
  echo "登入完成後再重新執行本腳本。"
  exit 1
fi

# 2. 若 R2 bucket 不存在就建立（R2 需要先在 Cloudflare 後台啟用，免費額度即可）
echo "==> 檢查 R2 bucket：$BUCKET"
if npx wrangler r2 bucket list 2>/dev/null | grep -qE "^name:\s+$BUCKET\s*$"; then
  echo "bucket 已存在"
else
  echo "建立 bucket $BUCKET"
  npx wrangler r2 bucket create "$BUCKET"
fi

# 3. 建立密碼（CREATE_SECRET）：只有知道它的人能建立新活動
#    已設定過就跳過；沒設定則互動式輸入（輸入內容不會顯示，也不會存進程式碼）
echo "==> 檢查 CREATE_SECRET"
if npx wrangler secret list 2>/dev/null | grep -q '"CREATE_SECRET"'; then
  echo "CREATE_SECRET 已設定（如需更換：npx wrangler secret put CREATE_SECRET）"
else
  echo "尚未設定 CREATE_SECRET，請輸入你要用的建立密碼："
  npx wrangler secret put CREATE_SECRET
fi

# 3b. Google 登入（選填）：wrangler.toml 的 GOOGLE_CLIENT_ID 有填，就需要 SESSION_SECRET（簽發登入 cookie 用）
CLIENT_ID="$(sed -nE 's/^[[:space:]]*GOOGLE_CLIENT_ID[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p' wrangler.toml | head -n 1 | tr -d '[:space:]')"
if [ -n "$CLIENT_ID" ]; then
  echo "==> 檢查 SESSION_SECRET（已啟用 Google 登入：${CLIENT_ID}）"
  if npx wrangler secret list 2>/dev/null | grep -q '"SESSION_SECRET"'; then
    echo "SESSION_SECRET 已設定（如需更換：npx wrangler secret put SESSION_SECRET；換掉後所有人需重新登入）"
  else
    echo "wrangler.toml 已設定 GOOGLE_CLIENT_ID，但還沒有 SESSION_SECRET。"
    echo "請輸入一串至少 32 字元的隨機字串（可在另一個終端機用 openssl rand -base64 32 產生）："
    npx wrangler secret put SESSION_SECRET
  fi
else
  echo "==> 未啟用 Google 登入（wrangler.toml 的 GOOGLE_CLIENT_ID 為空），略過 SESSION_SECRET"
fi

# 3c. 雲端硬碟連結匯入（選填）：沒有 GOOGLE_API_KEY 時只能匯入 Google 相簿連結
if npx wrangler secret list 2>/dev/null | grep -q '"GOOGLE_API_KEY"'; then
  echo "==> GOOGLE_API_KEY 已設定（雲端硬碟連結匯入可用；如需更換：npx wrangler secret put GOOGLE_API_KEY）"
else
  echo "==> 尚未設定 GOOGLE_API_KEY：只能匯入 Google 相簿連結。要開放雲端硬碟匯入，請執行 npx wrangler secret put GOOGLE_API_KEY"
fi

# 4. 部署
echo "==> 部署 Worker"
npx wrangler deploy

echo
echo "部署完成。每天 03:17 UTC 會自動清除過期活動的照片。"
echo "打開上面顯示的網址，用建立密碼建立第一個活動。"
