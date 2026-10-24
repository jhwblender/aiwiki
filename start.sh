#!/usr/bin/env bash
# Start the wiki with one command.
#
#   ./start.sh             optimised version (rebuilds only when the code changed)
#   ./start.sh --dev       development version that reloads as code changes
#   ./start.sh --open      also open the wiki in your browser once it is ready
#   ./start.sh --shortcut  put a "Start wiki" file on the Windows desktop (WSL only)
#   PORT=3001 ./start.sh   start from another port (a busy port falls back to the next free one)
#
# The first run checks for Node, npm and git, offers to download Node 22 if it
# is missing, installs the packages, and creates .env.local from .env.example.

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
PORT_FILE=.aiwiki-port
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

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  fail "PORT must be a number from 1 to 65535 (got \"$PORT\")."
fi

# Is the wiki answering on a port? curl is the obvious tool, but Node is always
# here by the time this is used, so a machine without curl still works.
healthy_at() {
  local port="$1" path="$2"
  if command -v curl >/dev/null; then
    curl -sf -o /dev/null -m 2 "http://localhost:${port}${path}"
  else
    node -e '
      const http = require("http");
      const req = http.get({ host: "127.0.0.1", port: process.argv[1], path: process.argv[2], timeout: 2000 }, res => {
        res.resume();
        process.exit(res.statusCode && res.statusCode >= 200 && res.statusCode < 400 ? 0 : 1);
      });
      req.on("error", () => process.exit(1));
      req.on("timeout", () => { req.destroy(); process.exit(1); });
    ' "$port" "$path"
  fi
}

healthy() { healthy_at "$PORT" "$1"; }

# The port last used, so a fallback port is found again for "already running?"
# and by stop.sh. A stale file is ignored once nothing answers there.
saved_port() {
  [[ -f "$PORT_FILE" ]] || return 1
  local saved
  saved="$(tr -dc '0-9' < "$PORT_FILE" 2>/dev/null || true)"
  [[ "$saved" =~ ^[0-9]+$ ]] || return 1
  (( saved >= 1 && saved <= 65535 )) || return 1
  printf '%s\n' "$saved"
}

remember_port() { printf '%s\n' "$1" > "$PORT_FILE" 2>/dev/null || true; }

# Can this computer listen on the port, on both IPv4 and IPv6? Testing both
# catches a program that only listens on one of them.
port_is_free() {
  node -e '
    const net = require("net");
    const port = Number(process.argv[1]);
    const free = host => new Promise(resolve => {
      const server = net.createServer();
      server.once("error", error => resolve(error.code !== "EADDRINUSE"));
      server.listen({ port, host }, () => server.close(() => resolve(true)));
    });
    (async () => {
      if (!(await free("0.0.0.0"))) process.exit(1);
      if (!(await free("::"))) process.exit(1);
      process.exit(0);
    })();
  ' "$1" >/dev/null 2>&1
}

find_free_port() {
  local start="$1" last candidate
  last=$(( start + 19 ))
  if (( last > 65535 )); then last=65535; fi
  for (( candidate=start; candidate<=last; candidate++ )); do
    port_is_free "$candidate" && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}

fail_no_free_port() {
  local start="$1" last
  last=$(( start + 19 ))
  if (( last > 65535 )); then last=65535; fi
  fail "Ports ${start}-${last} are all in use. Choose a different starting port, for example PORT=4000 ./start.sh."
}

open_browser() {
  if command -v cmd.exe >/dev/null; then (cd /mnt/c 2>/dev/null; cmd.exe /c start "" "$1" >/dev/null 2>&1)
  elif command -v xdg-open >/dev/null; then xdg-open "$1" >/dev/null 2>&1
  elif command -v open >/dev/null; then open "$1"
  fi
}

# ---------- Node the script can install for this user ----------
# It lives under the user's data folder, so no administrator password is needed
# and nothing outside that folder is changed. Later runs find it here.
WIKI_NODE_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/aiwiki/node"
NODE_INSTALL_TMP=""

cleanup_node_install() {
  if [[ -n "$NODE_INSTALL_TMP" ]]; then
    rm -rf "$NODE_INSTALL_TMP" "${NODE_INSTALL_TMP}.tar.gz"
  fi
}
trap cleanup_node_install EXIT

wiki_node_works() {
  [[ -x "$WIKI_NODE_HOME/bin/node" ]] && "$WIKI_NODE_HOME/bin/node" -v >/dev/null 2>&1
}

ask_to_install_node() {
  local answer
  # Without a terminal (a service, a pipe, a plain double-click) nobody can answer.
  [[ -t 0 && -t 1 ]] || return 1
  printf '\nNode.js is not installed. The wiki needs Node 22.\n'
  printf 'Download Node 22 into\n  %s\nand use it for the wiki? This needs no administrator password (about 30 MB).\n' "$WIKI_NODE_HOME"
  printf 'Install Node 22 now? [y/N] '
  read -r answer || return 1
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else return 1
  fi
}

fetch_file() {
  if command -v curl >/dev/null; then
    curl -fL --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null; then
    wget -O "$2" "$1"
  else
    return 127
  fi
}

install_wiki_node() {
  local os arch index tarball expected actual staging archive sum

  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "Automatic Node.js install is not supported on $(uname -s). Install Node 22 or newer from https://nodejs.org, then run ./start.sh again." ;;
  esac
  if [[ -f /etc/alpine-release ]]; then
    fail "This is Alpine Linux, where Node's official builds do not run. Install Node 22 with 'sudo apk add nodejs npm', then run ./start.sh again."
  fi
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l)
      [[ "$os" == linux ]] || fail "Automatic Node.js install is not supported on $(uname -s) $(uname -m). Install Node 22 or newer from https://nodejs.org, then run ./start.sh again."
      arch=armv7l ;;
    *) fail "There is no Node.js 22 download for $(uname -m). Install it from https://nodejs.org, then run ./start.sh again." ;;
  esac

  command -v tar >/dev/null || fail "tar is needed to unpack Node.js. Install it (it is usually part of the system), then run ./start.sh again."
  command -v awk >/dev/null || fail "awk is needed to check the Node.js download. Install it, then run ./start.sh again."
  command -v curl >/dev/null || command -v wget >/dev/null \
    || fail "curl or wget is needed to download Node.js. Install one, then run ./start.sh again."

  mkdir -p "$(dirname "$WIKI_NODE_HOME")" \
    || fail "Could not create $(dirname "$WIKI_NODE_HOME"). Check that your home folder is writable, then run ./start.sh again."

  staging="$WIKI_NODE_HOME.partial.$$"
  archive="$staging.tar.gz"
  rm -rf "$staging" "$archive"
  mkdir -p "$staging" \
    || fail "Could not create $staging. Check that your home folder is writable, then run ./start.sh again."
  NODE_INSTALL_TMP="$staging"

  index="$staging/SHASUMS256.txt"
  say "Downloading Node.js 22 (about 30 MB)..."
  fetch_file "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" "$index" \
    || fail "Could not download Node.js. Check the internet connection, then run ./start.sh again."

  # The checksum file has one line per download; pick this computer's file.
  sum="$(awk -v suffix="-$os-$arch.tar.gz" 'index($2, suffix) == length($2) - length(suffix) + 1 { print $1, $2; exit }' "$index")"
  expected="${sum%% *}"
  tarball="${sum#* }"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] \
    || fail "Could not read the Node.js checksum. Try ./start.sh again; if it keeps failing, install Node 22 from https://nodejs.org."
  [[ "$tarball" =~ ^node-v22\.[0-9]+\.[0-9]+-$os-$arch\.tar\.gz$ ]] \
    || fail "Could not find a Node.js 22 download for this computer ($os $arch). Install Node 22 from https://nodejs.org, then run ./start.sh again."

  fetch_file "https://nodejs.org/dist/latest-v22.x/$tarball" "$archive" \
    || fail "Could not download $tarball. Check the internet connection, then run ./start.sh again."

  actual="$(sha256_file "$archive")" \
    || fail "Could not check the Node.js download (install sha256sum, shasum or openssl), then run ./start.sh again."
  [[ "$actual" == "$expected" ]] \
    || fail "The Node.js download did not match its checksum, so it was not used. Try ./start.sh again; if it keeps failing, install Node 22 from https://nodejs.org."

  tar -xzf "$archive" -C "$staging" --strip-components=1 \
    || fail "Could not unpack the Node.js download. Check that there is enough disk space, then run ./start.sh again."
  [[ -x "$staging/bin/node" ]] \
    || fail "The Node.js download did not contain node. Install Node 22 from https://nodejs.org, then run ./start.sh again."
  "$staging/bin/node" -v >/dev/null 2>&1 \
    || fail "The downloaded Node.js cannot run on this system (it needs a recent glibc). Install Node 22 with your package manager, then run ./start.sh again."

  # Replace an older or broken copy only once the new one is unpacked and checked.
  rm -rf "$WIKI_NODE_HOME" \
    || fail "Could not replace $WIKI_NODE_HOME. Check permissions, then run ./start.sh again."
  mv "$staging" "$WIKI_NODE_HOME" \
    || fail "Could not move Node.js into $WIKI_NODE_HOME. Check permissions, then run ./start.sh again."
  rm -f "$archive"
  NODE_INSTALL_TMP=""
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
command -v git >/dev/null || fail "git is not installed. Install it (sudo apt install git), then run this again."

# Use the Node this script downloaded on an earlier run.
if ! command -v node >/dev/null && wiki_node_works; then
  PATH="$WIKI_NODE_HOME/bin:$PATH"; export PATH
fi

# Node installed with nvm can be missing from a launcher's PATH (a login shell
# does not always read ~/.bashrc). Add the newest nvm version if there is one.
if ! command -v node >/dev/null && [[ -d "$HOME/.nvm/versions/node" ]]; then
  BEST_MAJOR=0
  for NVM_BIN in "$HOME"/.nvm/versions/node/v*/bin; do
    [[ -x "$NVM_BIN/node" ]] || continue
    NVM_VERSION="${NVM_BIN%/bin}"; NVM_VERSION="${NVM_VERSION##*/v}"; NVM_VERSION="${NVM_VERSION%%.*}"
    [[ "$NVM_VERSION" =~ ^[0-9]+$ ]] || continue
    if (( NVM_VERSION > BEST_MAJOR )); then
      BEST_MAJOR="$NVM_VERSION"
      PATH="$NVM_BIN:$PATH"; export PATH
    fi
  done
fi

if ! command -v node >/dev/null; then
  if ask_to_install_node; then
    install_wiki_node
    PATH="$WIKI_NODE_HOME/bin:$PATH"; export PATH
    command -v node >/dev/null \
      || fail "Node.js was downloaded to $WIKI_NODE_HOME, but it cannot be run. Delete that folder and run ./start.sh again."
    say "Using Node $(node -v) from $WIKI_NODE_HOME"
  else
    HINT=""
    [[ -t 0 && -t 1 ]] || HINT=" Run ./start.sh in a terminal to be offered an automatic install."
    if [[ -n "${WSL_DISTRO_NAME:-}" ]] && command -v node.exe >/dev/null; then
      fail "Node.js is installed on Windows, but not inside WSL, and the wiki runs in WSL.
  Install Node 22 or newer inside WSL (https://nodejs.org, or use nvm:
  https://github.com/nvm-sh/nvm), then run ./start.sh again.$HINT"
    fi
    fail "Node.js is not installed. Install Node 22 or newer (https://nodejs.org), then run ./start.sh again.$HINT"
  fi
fi
command -v npm >/dev/null || fail "npm is missing. It normally comes with Node.js; install Node 22 or newer (which includes npm), then run this again."

NODE_VERSION="$(node -v 2>/dev/null)" || fail "Node.js is installed but does not run. Reinstall Node 22 or newer, then run this again."
NODE_MAJOR="${NODE_VERSION#v}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || fail "Could not read the Node.js version (got '$NODE_VERSION'). Install Node 22 or newer, then run this again."
(( NODE_MAJOR >= 18 )) || fail "Node $NODE_VERSION is too old. Install Node 22 or newer."
(( NODE_MAJOR >= 22 )) || say "Note: Node $NODE_VERSION works, but Node 22 or newer is recommended (the PDF reader expects it)."

# ---------- already running? ----------
# Check the port used last time too, so a wiki running on a fallback port is
# found instead of starting a second copy on the next free one.
SAVED_PORT="$(saved_port || true)"
if [[ -n "$SAVED_PORT" ]] && healthy_at "$SAVED_PORT" /api/config; then
  PORT="$SAVED_PORT"
  say "The wiki is already running at http://localhost:${PORT}"
  [[ "$OPEN" == yes ]] && open_browser "http://localhost:${PORT}"
  exit 0
fi
if healthy /api/config; then
  remember_port "$PORT"
  say "The wiki is already running at http://localhost:${PORT}"
  [[ "$OPEN" == yes ]] && open_browser "http://localhost:${PORT}"
  exit 0
fi

# ---------- use the next free port if this one is taken ----------
if ! FREE_PORT="$(find_free_port "$PORT")"; then
  fail_no_free_port "$PORT"
fi
if [[ "$FREE_PORT" != "$PORT" ]]; then
  say "Port ${PORT} is already in use. Using port ${FREE_PORT} instead."
  PORT="$FREE_PORT"
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
# Another program may have taken the port while the wiki was installing or building.
if ! port_is_free "$PORT"; then
  if ! FREE_PORT="$(find_free_port "$PORT")"; then
    fail_no_free_port "$PORT"
  fi
  say "Port ${PORT} was taken while preparing the wiki. Using port ${FREE_PORT} instead."
  PORT="$FREE_PORT"
fi

LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
say "Starting the wiki"
echo "  On this computer:  http://localhost:${PORT}"
[[ -n "$LAN_IP" ]] && echo "  On the network:    http://${LAN_IP}:${PORT}  (if your firewall allows it)"
echo "  Stop it with Ctrl+C."
echo

# Remember it for "already running?" on the next start and for ./stop.sh.
remember_port "$PORT"

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
