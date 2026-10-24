#!/usr/bin/env bash
# Start the wiki with one command.
#
#   ./start.sh             optimised version (rebuilds only when the code changed)
#   ./start.sh --dev       development version that reloads as code changes
#   ./start.sh --open      also open the wiki in your browser once it is ready
#   ./start.sh --shortcut  put a "Start wiki" file on the Windows desktop (WSL only)
#   PORT=3001 ./start.sh   use another port
#
# The first run checks for Node, npm and git, installs the packages, and creates
# .env.local from .env.example.

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

# Is the wiki answering on a path? curl is the obvious tool, but Node is always
# here by the time this is used, so a machine without curl still works.
healthy() {
  local path="$1"
  if command -v curl >/dev/null; then
    curl -sf -o /dev/null -m 2 "http://localhost:${PORT}${path}"
  else
    node -e '
      const http = require("http");
      const req = http.get({ host: "127.0.0.1", port: process.argv[1], path: process.argv[2], timeout: 2000 }, res => {
        res.resume();
        process.exit(res.statusCode && res.statusCode >= 200 && res.statusCode < 400 ? 0 : 1);
      });
      req.on("error", () => process.exit(1));
      req.on("timeout", () => { req.destroy(); process.exit(1); });
    ' "$PORT" "$path"
  fi
}

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
# Node installed with nvm can be missing from a launcher's PATH (a login shell
# does not always read ~/.bashrc). Add the newest nvm version if there is one.
if ! command -v node >/dev/null && [[ -d "$HOME/.nvm/versions/node" ]]; then
  BEST_MAJOR=0
  for NODE_HOME in "$HOME"/.nvm/versions/node/v*/bin; do
    [[ -x "$NODE_HOME/node" ]] || continue
    NVM_VERSION="${NODE_HOME%/bin}"; NVM_VERSION="${NVM_VERSION##*/v}"; NVM_VERSION="${NVM_VERSION%%.*}"
    [[ "$NVM_VERSION" =~ ^[0-9]+$ ]] || continue
    if (( NVM_VERSION > BEST_MAJOR )); then
      BEST_MAJOR="$NVM_VERSION"
      PATH="$NODE_HOME:$PATH"; export PATH
    fi
  done
fi

if ! command -v node >/dev/null; then
  if [[ -n "${WSL_DISTRO_NAME:-}" ]] && command -v node.exe >/dev/null; then
    fail "Node.js is installed on Windows, but not inside WSL, and the wiki runs in WSL.
  Install Node 22 or newer inside WSL (https://nodejs.org, or use nvm:
  https://github.com/nvm-sh/nvm), then run ./start.sh again."
  fi
  fail "Node.js is not installed. Install Node 22 or newer (https://nodejs.org), then run this again."
fi
command -v npm >/dev/null || fail "npm is missing. It normally comes with Node.js; install Node 22 or newer (which includes npm), then run this again."
command -v git >/dev/null || fail "git is not installed. Install it (sudo apt install git), then run this again."

NODE_VERSION="$(node -v 2>/dev/null)" || fail "Node.js is installed but does not run. Reinstall Node 22 or newer, then run this again."
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || fail "Could not read the Node.js version (got '$NODE_VERSION'). Install Node 22 or newer, then run this again."
(( NODE_MAJOR >= 18 )) || fail "Node $NODE_VERSION is too old. Install Node 22 or newer."
(( NODE_MAJOR >= 22 )) || say "Note: Node $NODE_VERSION works, but Node 22 or newer is recommended (the PDF reader expects it)."

# ---------- already running? ----------
if healthy /api/config; then
  say "The wiki is already running at http://localhost:${PORT}"
  [[ "$OPEN" == yes ]] && open_browser "http://localhost:${PORT}"
  exit 0
fi

# ---------- packages: install when missing, incomplete, or when the package list changed ----------
STAMP=node_modules/.installed-lock

# Both the server and the native database module must work. Checking them
# catches a half-finished install and a Node upgrade that broke better-sqlite3.
packages_ready() {
  [[ -x node_modules/.bin/next ]] && node -e 'require("better-sqlite3")' >/dev/null 2>&1
}

[[ -f package-lock.json ]] || fail "package-lock.json is missing, so the packages cannot be installed. Restore it (git checkout -- package-lock.json) and run ./start.sh again."

if [[ ! -d node_modules || ! -f "$STAMP" ]] \
   || ! cmp -s package-lock.json "$STAMP" \
   || [[ package.json -nt "$STAMP" ]] \
   || ! packages_ready; then
  say "Installing packages (first run, or the package list changed)..."
  LOG="$(mktemp "${TMPDIR:-/tmp}/aiwiki-install.XXXXXX")"
  # A clean install on a fresh copy; otherwise only add what changed.
  # --include=dev keeps the build working even when NODE_ENV=production is set.
  NPM_ARGS=(--no-audit --no-fund --include=dev)
  if [[ -d node_modules ]]; then
    INSTALL=(npm install "${NPM_ARGS[@]}")
  else
    INSTALL=(npm ci "${NPM_ARGS[@]}")
  fi
  if ! "${INSTALL[@]}" 2>&1 | tee "$LOG"; then
    if grep -qiE 'EACCES|EPERM' "$LOG"; then
      fail "npm could not write to this folder. Fix the folder's ownership or permissions (do not run npm with sudo), then run ./start.sh again. Log: $LOG"
    elif grep -qiE 'ENOSPC' "$LOG"; then
      fail "There is not enough disk space to install the packages. Free some space, then run ./start.sh again. Log: $LOG"
    elif grep -qiE 'EUSAGE|npm ci can only|lock file.*synchron' "$LOG"; then
      fail "package.json and package-lock.json disagree. Run 'npm install' once to update the lock file, then run ./start.sh again. Log: $LOG"
    elif grep -qiE 'gyp|make: \*\*\*' "$LOG"; then
      fail "A package needs to be compiled, but the build tools are missing. Install them (sudo apt install build-essential python3, or on macOS: xcode-select --install), then run ./start.sh again. Log: $LOG"
    elif grep -qiE 'ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|network' "$LOG"; then
      fail "npm could not download the packages. Check the internet connection or proxy settings, then run ./start.sh again. Log: $LOG"
    fi
    fail "Installing packages failed. See the messages above and the log at $LOG."
  fi
  [[ -x node_modules/.bin/next ]] || fail "Packages were installed, but Next.js is missing from node_modules. Delete node_modules and run ./start.sh again."
  node -e 'require("better-sqlite3")' >/dev/null 2>&1 || fail "Packages were installed, but the database module (better-sqlite3) cannot start. Install the build tools (sudo apt install build-essential python3, or on macOS: xcode-select --install), delete node_modules, and run ./start.sh again."
  cp package-lock.json "$STAMP"
  rm -f "$LOG"
fi

# ---------- settings ----------
if [[ ! -f .env.local ]]; then
  cp .env.example .env.local
  say "Created .env.local. Connect a model on the Settings page once the wiki is open."
fi

# ---------- build when the code changed since the last build ----------
# The optimised version lives in its own folder so it never clashes with a development server
NEXT_BIN=node_modules/.bin/next
export NEXT_DIST_DIR=.next-prod
if [[ "$MODE" == prod ]]; then
  if [[ ! -f .next-prod/BUILD_ID ]] || [[ -n "$(find app components lib package.json package-lock.json next.config.mjs -newer .next-prod/BUILD_ID -print -quit 2>/dev/null)" ]]; then
    say "Building the wiki (only needed after an update; takes a minute)..."
    "$NEXT_BIN" build
  fi
fi

# ---------- start ----------
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
say "Starting the wiki"
echo "  On this computer:  http://localhost:${PORT}"
[[ -n "$LAN_IP" ]] && echo "  On the network:    http://${LAN_IP}:${PORT}  (if your firewall allows it)"
echo "  Stop it with Ctrl+C."
echo

# Open the browser once the wiki answers
if [[ "$OPEN" == yes ]]; then
  (for _ in $(seq 1 120); do
     healthy /api/config && { open_browser "http://localhost:${PORT}"; break; }
     sleep 1
   done) &
fi

if [[ "$MODE" == dev ]]; then
  unset NEXT_DIST_DIR
  exec "$NEXT_BIN" dev -p "$PORT"
else
  exec "$NEXT_BIN" start -p "$PORT"
fi
