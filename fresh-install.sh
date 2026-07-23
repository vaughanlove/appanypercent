#!/usr/bin/env bash
# fresh-install.sh — zero -> doctor-green for the appanypercent provisioner.
#
# Idempotent: safe to re-run any time; existing tools and .env answers are kept.
# What it does, in order:
#   1. verify node >= 20, ssh, rsync
#   2. npm install (pins Pi via package-lock.json)
#   3. install the PlanetScale CLI if missing (documented paths: brew on macOS,
#      binaries from github.com/planetscale/cli/releases on Linux -> ~/.local/bin)
#   4. connect your SSH key to exe.dev (interactive on first ever use)
#   5. prompt for config + secrets and write ./.env (0600, gitignored; the CLI auto-loads it)
#   6. PlanetScale auth (service token from .env, or `pscale auth login`)
#   7. npm run doctor — the source of truth for "am I ready?"
set -euo pipefail
cd "$(dirname "$0")"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
okay()  { printf '\033[32m ✓ \033[0m%s\n' "$*"; }
note()  { printf '\033[33m ! \033[0m%s\n' "$*"; }
die()   { printf '\033[31m ✗ %s\033[0m\n' "$*" >&2; exit 1; }
is_tty() { [ -t 0 ] && [ -t 1 ]; }

bold "appanypercent fresh install"
echo

# ── 1. base tooling ──────────────────────────────────────────────────────────
command -v node >/dev/null || die "node not found. Install Node 20+ (e.g. https://nodejs.org or: nvm install 20), then re-run."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "node v$(node -v) is too old — need >= 20 (nvm install 20)."
okay "node $(node -v)"
command -v ssh   >/dev/null || die "ssh not found (apt/brew install openssh-client)."
command -v rsync >/dev/null || die "rsync not found (apt/brew install rsync)."
okay "ssh + rsync"

# ── 2. repo dependencies (Pi pinned via lockfile) ────────────────────────────
if [ -d node_modules/@earendil-works/pi-coding-agent ]; then
  okay "npm dependencies already installed"
else
  echo "installing npm dependencies..."
  npm install --no-audit --no-fund >/dev/null
  okay "npm dependencies installed (Pi pinned by package-lock.json)"
fi

# ── 3. PlanetScale CLI ───────────────────────────────────────────────────────
# Documented install paths (planetscale.com/docs/cli/planetscale-environment-setup):
# macOS: brew install pscale. Linux: downloadable binaries / .deb / .rpm from
# github.com/planetscale/cli/releases. We install the binary to ~/.local/bin (no sudo).
if command -v pscale >/dev/null; then
  okay "pscale already installed ($(pscale version 2>/dev/null | head -1 || echo 'version unknown'))"
elif command -v brew >/dev/null; then
  echo "installing pscale via Homebrew..."
  brew install pscale >/dev/null
  okay "pscale installed (brew)"
elif [ "$(uname -s)" = "Linux" ]; then
  echo "installing pscale binary from github.com/planetscale/cli releases -> ~/.local/bin ..."
  ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported arch $ARCH — install pscale manually: https://github.com/planetscale/cli/releases" ;; esac
  TAG=$(curl -fsSL https://api.github.com/repos/planetscale/cli/releases/latest | grep -o '"tag_name": *"[^"]*"' | cut -d'"' -f4)
  [ -n "$TAG" ] || die "could not resolve latest pscale release — install manually: https://github.com/planetscale/cli/releases"
  VER=${TAG#v}
  mkdir -p "$HOME/.local/bin"
  curl -fsSL "https://github.com/planetscale/cli/releases/download/${TAG}/pscale_${VER}_linux_${ARCH}.tar.gz" | tar -xz -C "$HOME/.local/bin" pscale
  chmod +x "$HOME/.local/bin/pscale"
  export PATH="$HOME/.local/bin:$PATH"
  case ":$PATH:" in *":$HOME/.local/bin:"*) : ;; *) note "add ~/.local/bin to your PATH (e.g. in ~/.bashrc)";; esac
  okay "pscale ${TAG} installed to ~/.local/bin"
else
  die "no brew and not Linux — install pscale manually: https://planetscale.com/docs/cli/planetscale-environment-setup"
fi

# ── 4. exe.dev (the API is SSH; first contact registers your key) ────────────
if ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 exe.dev whoami >/dev/null 2>&1; then
  okay "exe.dev reachable and authenticated"
elif is_tty; then
  note "first exe.dev contact — opening an interactive session to register your SSH key."
  note "follow its prompts, then exit; the script continues."
  ssh -o StrictHostKeyChecking=accept-new exe.dev whoami || true
  ssh -o BatchMode=yes exe.dev whoami >/dev/null 2>&1 && okay "exe.dev authenticated" \
    || note "exe.dev still not authenticated — doctor will flag it (see https://exe.dev)"
else
  note "non-interactive shell: skipping exe.dev registration — run 'ssh exe.dev' yourself once."
fi

# ── 5. configuration -> ./.env (0600; the CLI auto-loads it; env vars still win)
touch .env && chmod 600 .env
get_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
set_env() { grep -vE "^$1=" .env > .env.tmp || true; printf '%s=%s\n' "$1" "$2" >> .env.tmp; mv .env.tmp .env; chmod 600 .env; }
ask() { # ask VAR "prompt" [secret]
  local var="$1" prompt="$2" secret="${3:-}" cur val
  cur="$(get_env "$var")"; [ -z "$cur" ] && cur="${!var:-}"
  if ! is_tty; then [ -n "$cur" ] && set_env "$var" "$cur"; return 0; fi
  if [ -n "$cur" ]; then
    if [ -n "$secret" ]; then printf '  %s [keep existing ****]: ' "$prompt"; else printf '  %s [%s]: ' "$prompt" "$cur"; fi
  else
    printf '  %s: ' "$prompt"
  fi
  if [ -n "$secret" ]; then read -rs val; echo; else read -r val; fi
  [ -z "$val" ] && val="$cur"
  [ -n "$val" ] && set_env "$var" "$val"
}

bold "configuration (stored in ./.env — gitignored, chmod 600; press Enter to keep shown values)"
ask PS_ORG "PlanetScale org"
ask PS_DATABASE "PlanetScale parent Postgres database (create once in the dashboard, leave 'main' empty)"
ask PLANETSCALE_SERVICE_TOKEN_ID "PlanetScale service token ID (empty = use 'pscale auth login' instead)"
if [ -n "$(get_env PLANETSCALE_SERVICE_TOKEN_ID)" ]; then
  ask PLANETSCALE_SERVICE_TOKEN "PlanetScale service token" secret
  # MCP verification uses the same service token unless overridden (docs: PLANETSCALE_API_TOKEN)
  [ -z "$(get_env PLANETSCALE_API_TOKEN)" ] && [ -n "$(get_env PLANETSCALE_SERVICE_TOKEN)" ] \
    && set_env PLANETSCALE_API_TOKEN "$(get_env PLANETSCALE_SERVICE_TOKEN)" \
    && okay "PLANETSCALE_API_TOKEN set from service token (enables MCP schema verification)"
fi
ask ANTHROPIC_API_KEY "LLM API key for the in-VM Pi generation step (ANTHROPIC_API_KEY)" secret
okay ".env written"

# ── 6. PlanetScale auth ──────────────────────────────────────────────────────
set -a; . ./.env; set +a
if [ -n "${PLANETSCALE_SERVICE_TOKEN_ID:-}" ] && [ -n "${PLANETSCALE_SERVICE_TOKEN:-}" ]; then
  okay "PlanetScale: using service token (headless)"
elif pscale auth check --format json >/dev/null 2>&1; then
  okay "PlanetScale: already logged in"
elif is_tty; then
  note "logging in to PlanetScale (browser flow)..."
  pscale auth login || note "login failed/skipped — doctor will flag it"
else
  note "non-interactive and no service token — doctor will flag PlanetScale auth"
fi

# ── 7. the source of truth ───────────────────────────────────────────────────
echo
bold "running doctor..."
npm run --silent doctor && DOCTOR_OK=1 || DOCTOR_OK=0
echo
if [ "$DOCTOR_OK" = 1 ]; then
  bold 'setup complete — next:'
  echo '  appanypercent plan --app demo --idea "a guestbook"        (dry run)'
  echo '  appanypercent provision --app demo --idea "a guestbook" --public'
else
  bold "setup incomplete — fix the ✗ items above and re-run: appanypercent setup   (idempotent)"
  exit 1
fi
