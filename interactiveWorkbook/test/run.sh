#!/usr/bin/env bash
# run.sh — 一鍵跑完「互動題本」PWA 的無頭煙霧測試。
#
# 用法：
#   ./run.sh                    # 測 /tmp/iw（預設）
#   IW_SRC=/path/to/other node.../run.sh   # 測別份程式碼副本
#   IW_PORT=9000 ./run.sh       # 換埠號（預設 8791）
#
# 會啟動 serve.mjs、等它就緒、跑 smoke.mjs，結束後不論成敗都關掉伺服器，
# 並把 smoke.mjs 的 exit code 原樣回傳。

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${IW_PORT:-8791}"
export IW_SRC="${IW_SRC:-/tmp/iw}"

node "$DIR/serve.mjs" --port "$PORT" &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1
  wait "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT

READY=0
for _ in $(seq 1 100); do
  if curl -sf "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.1
done

if [ "$READY" != "1" ]; then
  echo "伺服器啟動逾時（IW_SRC=$IW_SRC，PORT=$PORT）" >&2
  exit 1
fi

IW_BASE_URL="http://127.0.0.1:${PORT}" node "$DIR/smoke.mjs"
EXIT_CODE=$?
exit $EXIT_CODE
