#!/usr/bin/env bash
# BFD Workbench setup — macOS and Linux.
#
#   bash scripts/setup.sh
#
# Checks each prerequisite, installs what is missing where it safely can, and
# leaves you with a build that runs. Safe to re-run: every step is a no-op when
# the tool is already present.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OS="$(uname -s)"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

say "BFD Workbench setup ($OS)"

# --- 1. Platform build tools ---------------------------------------------------
say "1/6  Platform build tools"
if [ "$OS" = "Darwin" ]; then
  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode Command Line Tools"
  else
    warn "Installing Xcode Command Line Tools — accept the dialog, then re-run this script."
    xcode-select --install || true
    exit 1
  fi
else
  # Tauri on Linux needs webkit2gtk and friends.
  if command -v apt-get >/dev/null 2>&1; then
    warn "Debian/Ubuntu detected — installing Tauri system dependencies (sudo required)."
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  else
    warn "Install Tauri's Linux prerequisites for your distro: https://tauri.app/start/prerequisites/"
  fi
  ok "Platform build tools"
fi

# --- 2. Node.js ----------------------------------------------------------------
say "2/6  Node.js 18+"
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version)"
else
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install node
    ok "node $(node --version)"
  else
    die "Node.js not found. Install Node 18+ from https://nodejs.org and re-run."
  fi
fi

# --- 3. Rust -------------------------------------------------------------------
say "3/6  Rust toolchain"
if ! command -v rustc >/dev/null 2>&1 && [ -f "$HOME/.cargo/env" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi
if command -v rustc >/dev/null 2>&1; then
  ok "$(rustc --version)"
else
  warn "Installing Rust via rustup…"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  ok "$(rustc --version)"
fi
export PATH="$HOME/.cargo/bin:$PATH"

# --- 4. Claude CLI -------------------------------------------------------------
say "4/6  Claude CLI"
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null || echo installed)"
else
  warn "Installing @anthropic-ai/claude-code globally…"
  npm install -g @anthropic-ai/claude-code
  ok "Claude CLI installed"
fi

say "     Claude authentication"
if echo "reply with the word ok" | claude --print >/dev/null 2>&1; then
  ok "Authenticated"
else
  warn "Not authenticated. Run 'claude login' in a terminal, then re-run this script."
fi

# --- 5. Frontend dependencies --------------------------------------------------
say "5/6  npm dependencies"
cd "$ROOT"
npm install --no-audit --no-fund
ok "node_modules ready"

# --- 6. Rust build -------------------------------------------------------------
say "6/6  Building the Rust backend (first build takes several minutes)"
cd "$ROOT/src-tauri"
cargo build
ok "Backend built"

say "Setup complete"
cat <<'EOF'
  Run it:        npm run start        (dev build, hot reload)
  Package it:    npm run package      (installer in src-tauri/target/release/bundle/)

  Optional: create ~/.bfd/global.md with notes you want in every conversation.
EOF
