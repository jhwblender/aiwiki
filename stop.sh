#!/usr/bin/env bash
# Stop the wiki started with ./start.sh.
#
#   ./stop.sh             stops the wiki wherever ./start.sh left it running: the port it
#                         remembered, or — when that file is stale or gone — the Next.js
#                         server it finds listening in the usual range (3000-3019)
#   PORT=3001 ./stop.sh   stops a wiki on one particular port only
#
# When it cannot tell which server is the wiki (several are listening and none is the remembered
# port), it says which ports hold what rather than guessing. Only a Next.js process is ever
# stopped. Background filing pauses with the wiki; waiting files carry on the next time
# the wiki starts.

set -euo pipefail
PORT_FILE=.aiwiki-port
RANGE_FIRST=3000
RANGE_LAST=3019 # ./start.sh picks its fallback port from this range

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
hint() { printf '  \033[2m%s\033[0m\n' "$*"; }

saved_port() {
  [[ -f "$PORT_FILE" ]] || return 1
  local saved
  saved="$(tr -dc '0-9' < "$PORT_FILE" 2>/dev/null || true)"
  [[ "$saved" =~ ^[0-9]+$ ]] || return 1
  (( saved >= 1 && saved <= 65535 )) || return 1
  printf '%s\n' "$saved"
}

# Keep the file only while it describes the wiki that was stopped.
forget_port() {
  local port="$1"
  [[ -f "$PORT_FILE" ]] || return 0
  if [[ "$(saved_port || true)" == "$port" ]]; then
    rm -f "$PORT_FILE"
  fi
  return 0
}

answering_at() { curl -s -o /dev/null -m 2 "http://localhost:${1}/api/pulse"; }

is_next_process() {
  local p="$1" args comm
  args="$(ps -p "$p" -o args= 2>/dev/null || true)"
  comm="$(ps -p "$p" -o comm= 2>/dev/null || true)"
  [[ "$args" == *next* || "$comm" == next* ]]
}

# Pids listening on a port, however we can find them.
listener_pids() {
  local port="$1"
  if command -v ss >/dev/null; then
    ss -ltnp "sport = :${port}" 2>/dev/null | grep -o 'pid=[0-9]*' | tr -d 'pid=' | sort -u || true
  elif command -v lsof >/dev/null; then
    lsof -nP -tiTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null; then
    fuser "${port}/tcp" 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' || true
  fi
}

# The wiki's processes on a port: the Next.js listener on it and anything it started.
# Interactive shells are skipped, so a terminal that merely mentions the command never matches.
wiki_pids_on() {
  local port="$1" p found=no comm
  for p in $(listener_pids "$port"); do
    [[ "$p" == "$$" || "$p" == "$PPID" ]] && continue
    is_next_process "$p" || continue
    found=yes
    echo "$p"
    pgrep -P "$p" 2>/dev/null || true
  done
  if [[ "$found" == no ]]; then
    # Without ss, lsof and fuser the listener cannot be seen; fall back to the command line.
    for p in $(pgrep -f "next (start|dev) -p ${port}( |$)" 2>/dev/null || true); do
      [[ "$p" == "$$" || "$p" == "$PPID" ]] && continue
      comm="$(ps -p "$p" -o comm= 2>/dev/null || true)"
      [[ "$comm" =~ ^(bash|zsh|fish|tmux|screen|sudo)$ ]] && continue
      found=yes
      echo "$p"
      pgrep -P "$p" 2>/dev/null || true
    done
  fi
  [[ "$found" == yes ]]
}

# Every port where a Next.js server is listening right now (one per line, sorted).
next_listener_ports() {
  local line state recvq sendq addr peer rest port pid
  if command -v ss >/dev/null; then
    ss -ltnp 2>/dev/null | tail -n +2 | while read -r state recvq sendq addr peer rest; do
      port="${addr##*:}"
      [[ "$port" =~ ^[0-9]+$ ]] || continue
      for pid in $(printf '%s\n' "$rest" | grep -o 'pid=[0-9]*' | tr -d 'pid=' | sort -u); do
        if is_next_process "$pid"; then
          printf '%s\n' "$port"
          break
        fi
      done
    done | sort -nu
  elif command -v lsof >/dev/null; then
    for p in $(pgrep -f "next-server|next (start|dev)" 2>/dev/null || true); do
      lsof -nP -p "$p" -a -iTCP -sTCP:LISTEN 2>/dev/null | awk '$NF == "(LISTEN)" { v = $9; sub(/.*:/, "", v); print v }'
    done | sort -nu
  fi
}

# Stop the Next.js processes on one port and wait until nothing listens there.
stop_on_port() {
  local port="$1" pids
  pids="$(wiki_pids_on "$port" | sort -u | tr '\n' ' ')" || true
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    [[ -z "$(listener_pids "$port")" ]] && break
    sleep 0.5
  done
  if [[ -n "$(listener_pids "$port")" ]]; then
    pids="$(wiki_pids_on "$port" | sort -u | tr '\n' ' ')" || true
    kill -9 $pids 2>/dev/null || true
    forget_port "$port"
    say "The wiki on port ${port} did not stop by itself, so it was stopped forcefully. Start it again with ./start.sh"
  else
    forget_port "$port"
    say "The wiki has stopped (it was on port ${port}). Start it again with ./start.sh"
  fi
}

# Wiki-like servers still listening after a stop, except the one just stopped; never touched.
note_others() {
  local stopped="$1" port
  local others
  others="$(next_listener_ports | grep -v "^${stopped}\$" || true)"
  for port in $others; do
    hint "Another wiki-like server is still listening on port ${port} — stop it with PORT=${port} ./stop.sh"
  done
  return 0
}

in_range() { (( $1 >= RANGE_FIRST && $1 <= RANGE_LAST )); }

if [[ -n "${PORT:-}" ]]; then
  # A port was given: only that one is considered.
  if wiki_pids_on "$PORT" | grep -q .; then
    stop_on_port "$PORT"
    note_others "$PORT"
  elif answering_at "$PORT"; then
    say "Something is answering on port ${PORT}, but it was not started with ./start.sh, so it was left alone."
    exit 1
  else
    say "The wiki is not running on port ${PORT}."
  fi
  exit 0
fi

SAVED_PORT="$(saved_port || true)"

# The port ./start.sh remembered, so a fallback port is found again here. A stale file is
# ignored once nothing wiki-like is listening on it.
if [[ -n "$SAVED_PORT" ]]; then
  if wiki_pids_on "$SAVED_PORT" | grep -q .; then
    stop_on_port "$SAVED_PORT"
    note_others "$SAVED_PORT"
    exit 0
  fi
  if answering_at "$SAVED_PORT"; then
    say "Something is answering on port ${SAVED_PORT} (the port last used), but it was not started with ./start.sh, so it was left alone."
    exit 1
  fi
fi

# The remembered port is free. Find the wiki by what is listening.
LISTEN_PORTS="$(next_listener_ports || true)"

if [[ -z "$LISTEN_PORTS" ]]; then
  say "The wiki is not running."
  [[ -n "$SAVED_PORT" ]] && hint "(the port file still names ${SAVED_PORT}, but nothing is listening there)"
  exit 0
fi

total="$(wc -l <<< "$LISTEN_PORTS")"

if [[ "$total" == 1 ]]; then
  port="$LISTEN_PORTS"
  if in_range "$port"; then
    # The one wiki-like server, inside the range ./start.sh puts things in.
    stop_on_port "$port"
    note_others "$port"
    exit 0
  fi
  # Outside the range it is somebody's custom PORT start (or an unrelated Next.js app);
  # ./stop.sh does not guess.
  say "A Next.js server is listening on port ${port}, outside the wiki's usual range (${RANGE_FIRST}-${RANGE_LAST})."
  hint "If it is the wiki, stop it with PORT=${port} ./stop.sh"
  exit 0
fi

say "Several wiki-like servers are listening, so nothing was stopped:"
for port in $LISTEN_PORTS; do
  mark=""
  [[ "$port" == "$SAVED_PORT" ]] && mark=" (the port last used)"
  hint "port ${port}${mark} — stop it with PORT=${port} ./stop.sh"
done
exit 0