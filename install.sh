#!/usr/bin/env bash
# Sets up both halves of this project on a fresh Linux box:
#   1. TS3AudioBot   — the actual TeamSpeak client/music engine (upstream
#                       binary release from github.com/Splamy/TS3AudioBot,
#                       NOT vendored in this repo — downloaded here instead)
#   2. web controller — the Node.js app in this repo (server.js + public/)
#
# Safe to re-run: every step skips itself if already done, so this also
# works as a general "make sure everything's still in place" check.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS3AB_DIR="$ROOT_DIR/ts3audiobot"
TS3AB_VERSION="0.12.0"
NODE_MIN_MAJOR=18

c_bold=$'\033[1m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_reset=$'\033[0m'
info()  { echo "${c_bold}==>${c_reset} $*"; }
ok()    { echo "${c_green}✓${c_reset} $*"; }
warn()  { echo "${c_yellow}!${c_reset} $*"; }
fail()  { echo "${c_red}✗ $*${c_reset}" >&2; exit 1; }

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "This installer targets Linux (the project runs on a Linux server). Detected: $(uname -s)"
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  TS3AB_ASSET="TS3AudioBot_linux_x64.tar.gz" ;;
  aarch64) TS3AB_ASSET="TS3AudioBot_linux_arm64.tar.gz" ;;
  armv7l)  TS3AB_ASSET="TS3AudioBot_linux_arm.tar.gz" ;;
  *) fail "Unsupported architecture: $ARCH" ;;
esac

# ── 1. System packages ──────────────────────────────────────────────────
info "Checking system dependencies (ffmpeg, curl, tar)..."
MISSING_PKGS=()
command -v ffmpeg >/dev/null 2>&1 || MISSING_PKGS+=(ffmpeg)
command -v curl   >/dev/null 2>&1 || MISSING_PKGS+=(curl)
command -v tar    >/dev/null 2>&1 || MISSING_PKGS+=(tar)

if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    info "Installing missing packages via apt: ${MISSING_PKGS[*]}"
    apt-get update -qq
    apt-get install -y "${MISSING_PKGS[@]}"
  else
    fail "Missing: ${MISSING_PKGS[*]} — install these manually (no apt-get found)."
  fi
fi
ok "ffmpeg, curl, tar present"

# ── 2. Node.js ───────────────────────────────────────────────────────────
info "Checking Node.js (need >= ${NODE_MIN_MAJOR})..."
node_ok=false
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -v | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ]]; then
    node_ok=true
    ok "Node $(node -v) found"
  else
    warn "Node $(node -v) is too old (need >= ${NODE_MIN_MAJOR})"
  fi
else
  warn "Node.js not found"
fi

if [[ "$node_ok" != true ]]; then
  if command -v apt-get >/dev/null 2>&1; then
    info "Installing Node.js ${NODE_MIN_MAJOR}.x via NodeSource..."
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_MAJOR}.x" | bash -
    apt-get install -y nodejs
    ok "Node $(node -v) installed"
  else
    fail "Install Node.js >= ${NODE_MIN_MAJOR} manually, then re-run this script."
  fi
fi

# ── 3. TS3AudioBot (upstream binary) ────────────────────────────────────
info "Checking TS3AudioBot..."
if [[ -x "$TS3AB_DIR/TS3AudioBot" ]]; then
  ok "TS3AudioBot already installed at $TS3AB_DIR"
else
  info "Downloading TS3AudioBot ${TS3AB_VERSION} (${TS3AB_ASSET}) from GitHub releases..."
  TMP_TAR="$(mktemp)"
  DL_URL="https://github.com/Splamy/TS3AudioBot/releases/download/${TS3AB_VERSION}/${TS3AB_ASSET}"
  curl -fL --progress-bar -o "$TMP_TAR" "$DL_URL" || fail "Download failed: $DL_URL"
  mkdir -p "$TS3AB_DIR"
  tar -xzf "$TMP_TAR" -C "$TS3AB_DIR"
  rm -f "$TMP_TAR"
  chmod +x "$TS3AB_DIR/TS3AudioBot"
  ok "TS3AudioBot ${TS3AB_VERSION} extracted to $TS3AB_DIR"
fi

mkdir -p "$TS3AB_DIR/plugins" "$TS3AB_DIR/logs"

if [[ ! -f "$TS3AB_DIR/ts3audiobot.toml" ]]; then
  cp "$TS3AB_DIR/ts3audiobot.toml.example" "$TS3AB_DIR/ts3audiobot.toml"
  warn "Created ts3audiobot/ts3audiobot.toml from the example — EDIT IT before starting:"
  warn "  - [connect] address        → your TeamSpeak server's IP:port"
  warn "  - [query] username/password → a ServerQuery login on that server"
  warn "  - [bot.connect] channel     → the channel the bot should join"
else
  ok "ts3audiobot/ts3audiobot.toml already exists, leaving it alone"
fi

if [[ ! -f "$TS3AB_DIR/rights.toml" ]]; then
  cp "$TS3AB_DIR/rights.toml.example" "$TS3AB_DIR/rights.toml"
fi

# ── 4. Web controller (this repo's Node app) ────────────────────────────
info "Installing web controller npm dependencies..."
(cd "$ROOT_DIR" && npm install --omit=dev)
ok "npm install complete"

mkdir -p "$ROOT_DIR/music"

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  warn "Created .env from .env.example — EDIT IT before starting (WEB_USERNAME/WEB_PASSWORD at minimum)."
else
  ok ".env already exists, leaving it alone"
fi

# ── 5. Process management (pm2) ─────────────────────────────────────────
info "Checking pm2..."
if ! command -v pm2 >/dev/null 2>&1; then
  info "Installing pm2 globally..."
  npm install -g pm2
fi
ok "pm2 $(pm2 -v) available"

echo
echo "${c_bold}──────────────────────────────────────────────────────────${c_reset}"
echo "${c_bold} Setup complete. Before starting, edit:${c_reset}"
echo "   - ${c_bold}.env${c_reset}                              (web controller login, etc.)"
echo "   - ${c_bold}ts3audiobot/ts3audiobot.toml${c_reset}       (TeamSpeak server address + ServerQuery login)"
echo
read -r -p "Start both services now with pm2? [y/N] " REPLY
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  pm2 start "$TS3AB_DIR/TS3AudioBot" --name ts3audiobot --cwd "$TS3AB_DIR"
  pm2 start "$ROOT_DIR/server.js" --name ts3-music-web --cwd "$ROOT_DIR"
  pm2 save
  info "Run 'pm2 startup' (and follow its instructions) to also survive a reboot."
else
  echo "Skipped. Start manually once configured:"
  echo "  pm2 start $TS3AB_DIR/TS3AudioBot --name ts3audiobot --cwd $TS3AB_DIR"
  echo "  pm2 start $ROOT_DIR/server.js --name ts3-music-web --cwd $ROOT_DIR"
  echo "  pm2 save"
fi

echo
echo "${c_bold}Next steps / cheat sheet:${c_reset}"
echo "  Web UI:            http://<this-server>:9090  (port set in server.js CONFIG.webPort)"
echo "  View logs:          pm2 logs ts3audiobot | pm2 logs ts3-music-web"
echo "  Restart:             pm2 restart ts3audiobot | pm2 restart ts3-music-web"
echo "  Stop:                 pm2 stop ts3audiobot | pm2 stop ts3-music-web"
echo "  Add music:            drop files into ./music/ (or use the web UI's upload/import)"
echo "  Edit TS3AudioBot config again: ts3audiobot/ts3audiobot.toml, then: pm2 restart ts3audiobot"
