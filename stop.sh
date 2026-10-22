#!/usr/bin/env bash
# Stop the wiki started with ./start.sh.
#
#   ./stop.sh             stops the wiki on port 3000
#   PORT=3001 ./stop.sh   stops the one on another port
#
# Background filing pauses with it; waiting files carry on the next time the wiki starts.

set -euo pipefail
PORT="${PORT:-3000}"

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

# The process listening on the port, if it is the wiki (a Next.js server)
pid_on_port() {
  local pid
  pid="$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)"
  [[ -z "$pid" ]] && command -v lsof >/dev/null && pid="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  echo "$pid"
}

PID="$(pid_on_port)"
if [[ -z "$PID" ]]; then
  say "The wiki is not running on port ${PORT}."
  exit 0
fi
if ! tr '\0' ' ' < "/proc/${PID}/cmdline" 2>/dev/null | grep -q next; then
  say "Something else is using port ${PORT} (process ${PID}); leaving it alone."
  exit 1
fi

kill "$PID"
for _ in $(seq 1 20); do
  [[ -z "$(pid_on_port)" ]] && { say "The wiki has stopped. Start it again with ./start.sh"; exit 0; }
  sleep 0.5
done
kill -9 "$PID" 2>/dev/null || true
say "The wiki did not stop by itself, so it was stopped forcefully. Start it again with ./start.sh"
