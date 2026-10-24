#!/usr/bin/env bash
# Stop the wiki started with ./start.sh.
#
#   ./stop.sh             stops the wiki where start.sh put it (port 3000, or a fallback)
#   PORT=3001 ./stop.sh   stops the one on another port
#
# Background filing pauses with it; waiting files carry on the next time the wiki starts.

set -euo pipefail
PORT_FILE=.aiwiki-port

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }

saved_port() {
  [[ -f "$PORT_FILE" ]] || return 1
  local saved
  saved="$(tr -dc '0-9' < "$PORT_FILE" 2>/dev/null || true)"
  [[ "$saved" =~ ^[0-9]+$ ]] || return 1
  (( saved >= 1 && saved <= 65535 )) || return 1
  printf '%s\n' "$saved"
}

answering_at() { curl -s -o /dev/null -m 2 "http://localhost:${1}/api/pulse"; }
answering() { answering_at "$PORT"; }

# start.sh remembers the port it used; follow it unless PORT was given.
if [[ -z "${PORT:-}" ]]; then
  SAVED_PORT="$(saved_port || true)"
  if [[ -n "$SAVED_PORT" ]] && answering_at "$SAVED_PORT"; then
    PORT="$SAVED_PORT"
  else
    PORT=3000
  fi
fi
PORT="${PORT:-3000}"

# Keep the file only while it describes the wiki that was stopped.
forget_port() {
  [[ -f "$PORT_FILE" ]] || return 0
  if [[ "$(saved_port || true)" == "$PORT" ]]; then
    rm -f "$PORT_FILE"
  fi
  return 0
}

# The wiki's process, found by the port it listens on. Next replaces its process
# title with "next-server", so matching the start command line is not enough.
port_pids() {
  if command -v ss >/dev/null; then
    ss -ltnp "sport = :${PORT}" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p'
  elif command -v lsof >/dev/null; then
    lsof -nP -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null
  elif command -v fuser >/dev/null; then
    fuser "${PORT}/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true
  fi
}

is_next_process() {
  local p="$1" args comm
  args="$(ps -p "$p" -o args= 2>/dev/null || true)"
  comm="$(ps -p "$p" -o comm= 2>/dev/null || true)"
  [[ "$args" == *next* || "$comm" == next* ]]
}

# The wiki's processes: the listener on the port and anything it started.
# Interactive shells are skipped, so a terminal or script that merely mentions
# the command is never stopped.
wiki_pids() {
  local p found=no comm
  for p in $(port_pids | sort -u); do
    [[ "$p" == "$$" || "$p" == "$PPID" ]] && continue
    is_next_process "$p" || continue
    found=yes
    echo "$p"
    pgrep -P "$p" || true
  done
  # Systems without ss, lsof or fuser: fall back to the command line.
  if [[ "$found" == no ]]; then
    for p in $(pgrep -f "next (start|dev) -p ${PORT}( |$)" || true); do
      [[ "$p" == "$$" || "$p" == "$PPID" ]] && continue
      comm="$(cat "/proc/$p/comm" 2>/dev/null || true)"
      [[ "$comm" =~ ^(bash|zsh|fish|tmux|screen|sudo)$ ]] && continue
      echo "$p"
      pgrep -P "$p" || true
    done
  fi
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
  answering || { forget_port; say "The wiki has stopped. Start it again with ./start.sh"; exit 0; }
  sleep 0.5
done
kill -9 $PIDS 2>/dev/null || true
forget_port
say "The wiki did not stop by itself, so it was stopped forcefully. Start it again with ./start.sh"
