#!/usr/bin/env bash
# Installs glaude (Claude Code on Gloo AI) and godex (Codex on Gloo AI).
#   curl -fsSL https://raw.githubusercontent.com/matthewmichel/glaude/main/install.sh | bash
#   ... | bash -s -- --uninstall
# Environment overrides: GLOO_API_KEY, GLAUDE_SET_DEFAULT=1|0, GLOO_HOME, GLOO_BIN_DIR, GLOO_REPO_URL, GLOO_REF
set -euo pipefail

REPO_URL="${GLOO_REPO_URL:-https://github.com/matthewmichel/glaude.git}"
REF="${GLOO_REF:-main}"
INSTALL_DIR="${GLOO_HOME:-$HOME/.local/share/glaude}"
BIN_DIR="${GLOO_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="$HOME/.config/glaude"
CONFIG_FILE="$CONFIG_DIR/env"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -x "$INSTALL_DIR/bin/glaude" ]]; then
    "$INSTALL_DIR/bin/glaude" --unset-default || true
    "$INSTALL_DIR/bin/glaude" --stop-proxy || true
  fi
  rm -f "$BIN_DIR/glaude" "$BIN_DIR/godex"
  rm -rf "$INSTALL_DIR"
  say "Removed glaude, godex and $INSTALL_DIR"
  say "Your Gloo key is still in $CONFIG_FILE (delete it with: rm -r $CONFIG_DIR)"
  exit 0
fi

for cmd in git curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required"
done
command -v node >/dev/null 2>&1 || die "Node.js 24+ is required (https://nodejs.org)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
((node_major >= 24)) || die "Node.js 24+ is required (found $(node --version))"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  say "Updating $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin "$REF"
  git -C "$INSTALL_DIR" checkout --quiet "$REF"
  git -C "$INSTALL_DIR" reset --quiet --hard "origin/$REF"
  "$INSTALL_DIR/bin/glaude" --stop-proxy >/dev/null 2>&1 || true
else
  say "Installing to $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
fi
chmod +x "$INSTALL_DIR/bin/glaude" "$INSTALL_DIR/bin/godex"

if [[ ! -f "$CONFIG_FILE" ]]; then
  key="${GLOO_API_KEY:-}"
  if [[ -z "$key" ]] && (: </dev/tty) 2>/dev/null; then
    printf 'Gloo AI API key (from https://studio.ai.gloo.com, input hidden): ' >/dev/tty
    read -rs key </dev/tty
    printf '\n' >/dev/tty
  fi
  mkdir -p "$CONFIG_DIR"
  umask 077
  cat >"$CONFIG_FILE" <<EOF
# glaude configuration (read by the local proxy behind glaude/godex)
GLOO_API_KEY=$key
PORT=8787
# Model used by godex when -m is not given
GODEX_MODEL=gloo-anthropic-claude-sonnet-4.6
# Used when a requested Claude id has no Gloo equivalent
GLOO_DEFAULT_MODEL=gloo-anthropic-claude-sonnet-4.6
GLOO_PROXY_DEBUG=false
EOF
  chmod 600 "$CONFIG_FILE"
  if [[ -z "$key" ]]; then
    warn "No API key entered. Add GLOO_API_KEY to $CONFIG_FILE before running glaude/godex."
  else
    say "Saved your key to $CONFIG_FILE"
  fi
else
  say "Keeping existing config at $CONFIG_FILE"
fi

mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/glaude" "$BIN_DIR/glaude"
ln -sf "$INSTALL_DIR/bin/godex" "$BIN_DIR/godex"
say "Linked glaude and godex into $BIN_DIR"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
set_default="${GLAUDE_SET_DEFAULT:-}"
if [[ -z "$set_default" ]] && (: </dev/tty) 2>/dev/null; then
  printf 'Also make plain `claude` (terminal, scripts, IDE extension) use Gloo? [y/N] ' >/dev/tty
  read -r answer </dev/tty
  [[ "$answer" =~ ^[Yy] ]] && set_default=1
fi
if [[ "$set_default" == 1 ]]; then
  "$INSTALL_DIR/bin/glaude" --set-default || warn "Could not update Claude Code settings; run 'glaude --set-default' later."
fi

command -v claude >/dev/null 2>&1 || warn "Claude Code not found; glaude needs it: https://code.claude.com/docs/en/setup"
command -v codex >/dev/null 2>&1 || warn "Codex not found; godex needs it: npm install -g @openai/codex"

cat <<EOF

Done. Try:
  glaude                 Claude Code on Gloo AI
  godex                  Codex on Gloo AI
  glaude --update        pull the latest version
  glaude --proxy-log     follow the proxy log
  glaude --set-default   make plain \`claude\` use Gloo too (undo: --unset-default)
EOF
