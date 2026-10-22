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

answering() { curl -s -o /dev/null -m 2 "http://localhost:${PORT}/api/pulse"; }

# The wiki's processes: "next start/dev -p PORT" (started by npm or npx) and the server under it.
# Found by command line, so it works whichever terminal or tool started the wiki.
# Interactive shells are skipped, so a terminal or script that merely mentions the command is never stopped.
wiki_pids() {
  local p comm
  for p in $(pgrep -f "next (start|dev) -p ${PORT}( |$)" || true); do
    [[ "$p" == "$$" || "$p" == "$PPID" ]] && continue
    comm="$(cat "/proc/$p/comm" 2>/dev/null || true)"
    [[ "$comm" =~ ^(bash|zsh|fish|tmux|screen|sudo)$ ]] && continue
    echo "$p"
    pgrep -P "$p" || true
  done
}

if ! answering; then
  say "The wiki is not running on port ${PORT}."
  exit 0
fi
PIDS="$(wiki_pids | sort -u | tr '\n' ' ')"
if [[ -z "${PIDS// /}" ]]; then
  say "Something is answering on port ${PORT}, but it was not started with ./start.sh, so it was left alone."
  exit 1
fi

kill $PIDS 2>/dev/null || true
for _ in $(seq 1 20); do
  answering || { say "The wiki has stopped. Start it again with ./start.sh"; exit 0; }
  sleep 0.5
done
kill -9 $PIDS 2>/dev/null || true
say "The wiki did not stop by itself, so it was stopped forcefully. Start it again with ./start.sh"
