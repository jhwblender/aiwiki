#!/usr/bin/env bash
# Start the wiki with one command.
#
#   ./start.sh             optimised version (rebuilds only when the code changed)
#   ./start.sh --dev       development version that reloads as code changes
#   ./start.sh --open      also open the wiki in your browser once it is ready
#   ./start.sh --shortcut  put a "Start wiki" file on the Windows desktop (WSL only)
#   PORT=3001 ./start.sh   use another port
#
# The first run installs packages and creates .env.local from .env.example.

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
MODE=prod
OPEN=no
SHORTCUT=no
for arg in "$@"; do
  case "$arg" in
    --dev) MODE=dev ;;
    --open) OPEN=yes ;;
    --shortcut) SHORTCUT=yes ;;
    *) echo "Unknown option: $arg (use --dev, --open or --shortcut)" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

open_browser() {
  if command -v cmd.exe >/dev/null; then (cd /mnt/c 2>/dev/null; cmd.exe /c start "" "$1" >/dev/null 2>&1)
  elif command -v xdg-open >/dev/null; then xdg-open "$1" >/dev/null 2>&1
  elif command -v open >/dev/null; then open "$1"
  fi
}

# ---------- Windows desktop shortcut ----------
if [[ "$SHORTCUT" == yes ]]; then
  command -v powershell.exe >/dev/null || fail "--shortcut only works inside WSL on Windows."
  DESKTOP="$(wslpath "$(cd /mnt/c && powershell.exe -NoProfile -Command "[Environment]::GetFolderPath('Desktop')" | tr -d '\r')")"
  [[ -d "$DESKTOP" ]] || fail "Could not find the Windows desktop folder."
  DISTRO_ARG=""
  [[ -n "${WSL_DISTRO_NAME:-}" ]] && DISTRO_ARG="-d \"$WSL_DISTRO_NAME\" "
  printf '@echo off\r\ntitle Team wiki\r\nwsl.exe %s--cd "%s" bash -lc "./start.sh --open"\r\npause\r\n' "$DISTRO_ARG" "$(pwd)" > "$DESKTOP/Start wiki.cmd"
  say "Created \"Start wiki\" on your Windows desktop. Double-click it to start the wiki; close its window to stop it."
  exit 0
fi

# ---------- requirements ----------
command -v node >/dev/null || fail "Node.js is not installed. Install Node 22 or newer, then run this again."
command -v git >/dev/null || fail "git is not installed. Install it (sudo apt install git), then run this again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || fail "Node $(node -v) is too old. Install Node 22 or newer."
(( NODE_MAJOR >= 22 )) || say "Note: Node $(node -v) works, but Node 22 or newer is recommended (the PDF reader expects it)."

# ---------- already running? ----------
if curl -s -o /dev/null -m 2 "http://localhost:${PORT}/api/config"; then
  say "The wiki is already running at http://localhost:${PORT}"
  [[ "$OPEN" == yes ]] && open_browser "http://localhost:${PORT}"
  exit 0
fi

# ---------- packages: install when missing or when package-lock.json changed ----------
STAMP=node_modules/.installed-lock
if [[ ! -d node_modules || ! -f "$STAMP" ]] || ! cmp -s package-lock.json "$STAMP"; then
  say "Installing packages (first run, or the package list changed)..."
  # A clean install on a fresh copy; otherwise only add what changed
  if [[ -d node_modules ]]; then npm install --no-audit --no-fund; else npm ci --no-audit --no-fund; fi
  cp package-lock.json "$STAMP"
fi

# ---------- settings ----------
if [[ ! -f .env.local ]]; then
  cp .env.example .env.local
  say "Created .env.local. Connect a model on the Settings page once the wiki is open."
fi

# ---------- build when the code changed since the last build ----------
# The optimised version lives in its own folder so it never clashes with a development server
export NEXT_DIST_DIR=.next-prod
if [[ "$MODE" == prod ]]; then
  if [[ ! -f .next-prod/BUILD_ID ]] || [[ -n "$(find app components lib package-lock.json next.config.mjs -newer .next-prod/BUILD_ID -print -quit 2>/dev/null)" ]]; then
    say "Building the wiki (only needed after an update; takes a minute)..."
    npx next build
  fi
fi

# ---------- start ----------
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
say "Starting the wiki"
echo "  On this computer:  http://localhost:${PORT}"
[[ -n "$LAN_IP" ]] && echo "  On the network:    http://${LAN_IP}:${PORT}  (if your firewall allows it)"
echo "  Stop it with Ctrl+C."
echo

# Open the browser once the wiki answers
if [[ "$OPEN" == yes ]]; then
  (for _ in $(seq 1 120); do
     curl -s -o /dev/null -m 2 "http://localhost:${PORT}/api/config" && { open_browser "http://localhost:${PORT}"; break; }
     sleep 1
   done) &
fi

if [[ "$MODE" == dev ]]; then
  unset NEXT_DIST_DIR
  exec npx next dev -p "$PORT"
else
  exec npx next start -p "$PORT"
fi
