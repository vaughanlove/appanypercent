#!/usr/bin/env bash
# appanypercent installer — the one-liner:
#
#   curl -fsSL https://raw.githubusercontent.com/vaughanlove/appanypercent/main/install.sh | bash
#
# What it does (idempotent):
#   1. clone (or update) the harness to ~/.appanypercent  (override: APPANYPERCENT_HOME=...)
#   2. npm install  (Pi pinned via package-lock.json — Pi is a wrapped dependency, never a fork)
#   3. link the `appanypercent` command into ~/.local/bin (no sudo)
# Then you run exactly one more command:  appanypercent setup
set -euo pipefail

REPO="${APPANYPERCENT_REPO:-https://github.com/vaughanlove/appanypercent}"
HOME_DIR="${APPANYPERCENT_HOME:-$HOME/.appanypercent}"
BIN_DIR="$HOME/.local/bin"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
okay() { printf '\033[32m ✓ \033[0m%s\n' "$*"; }
die()  { printf '\033[31m ✗ %s\033[0m\n' "$*" >&2; exit 1; }

bold "installing appanypercent"

command -v git  >/dev/null || die "git not found — install git first."
command -v node >/dev/null || die "node not found — install Node 20+ first (https://nodejs.org or: nvm install 20)."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "node $(node -v) too old — need >= 20."

if [ -d "$HOME_DIR/.git" ]; then
  git -C "$HOME_DIR" pull --ff-only
  okay "updated existing install at $HOME_DIR"
else
  git clone --depth 1 "$REPO" "$HOME_DIR"
  okay "cloned $REPO -> $HOME_DIR"
fi

(cd "$HOME_DIR" && npm install --no-audit --no-fund >/dev/null)
PI_VERSION=$(cd "$HOME_DIR" && node -p "require('@earendil-works/pi-coding-agent/package.json').version")
okay "dependencies installed (Pi pinned at $PI_VERSION)"

mkdir -p "$BIN_DIR"
ln -sf "$HOME_DIR/bin/appanypercent.mjs" "$BIN_DIR/appanypercent"
chmod +x "$HOME_DIR/bin/appanypercent.mjs"
okay "linked $BIN_DIR/appanypercent"

case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *) printf '\033[33m ! \033[0m%s\n' "add ~/.local/bin to PATH:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && exec bash" ;;
esac

echo
bold "installed. one command left:"
echo "  appanypercent setup"
