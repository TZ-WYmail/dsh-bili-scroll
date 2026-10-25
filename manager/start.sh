#!/bin/sh
# B站值班台 launcher: start the local server if needed, then open the UI.
DIR=$(cd "$(dirname "$0")" && pwd)
PORT=${BILI_DUTY_PORT:-3099}
URL="http://127.0.0.1:$PORT/"
LOG="$HOME/.local/state/bili-duty-manager.log"
PIDFILE="$HOME/.local/state/bili-duty-manager.pid"
NODE_BIN=$(command -v node || echo /usr/local/bin/node)

mkdir -p "$HOME/.local/state"

healthy() {
  curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null
}

if ! healthy; then
  ( setsid nohup "$NODE_BIN" "$DIR/server.mjs" >"$LOG" 2>&1 & echo $! >"$PIDFILE" )
  i=0
  while [ $i -lt 40 ]; do
    healthy && break
    i=$((i + 1))
    sleep 0.25
  done
fi

if [ "$1" = "--server-only" ]; then
  exit 0
fi

if healthy; then
  xdg-open "$URL" >/dev/null 2>&1 &
else
  echo "值班台没起来，看日志：$LOG" >&2
  exit 1
fi
