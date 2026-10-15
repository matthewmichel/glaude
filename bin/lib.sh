# Shared helpers for glaude / godex. Expects GLOO_ROOT to be set to the repo root.

GLOO_CONFIG_FILE="${GLOO_CONFIG_FILE:-$HOME/.config/glaude/env}"
if [[ ! -f "$GLOO_CONFIG_FILE" && -f "$GLOO_ROOT/.env" ]]; then
  GLOO_CONFIG_FILE="$GLOO_ROOT/.env"
fi
GLOO_LOG="${GLOO_PROXY_LOG:-$HOME/Library/Logs/gloo-proxy.log}"
[[ "$(uname)" == "Darwin" ]] || GLOO_LOG="${GLOO_PROXY_LOG:-${XDG_STATE_HOME:-$HOME/.local/state}/glaude/proxy.log}"

gloo_config() {
  [[ -f "$GLOO_CONFIG_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$GLOO_CONFIG_FILE" | tail -1 | tr -d '"'"'"
}

GLOO_PORT="${PORT:-$(gloo_config PORT)}"
GLOO_PORT="${GLOO_PORT:-8787}"
GLOO_PROXY_URL="${GLOO_PROXY_URL:-http://127.0.0.1:$GLOO_PORT}"
GLOO_PROXY_TOKEN="${PROXY_AUTH_TOKEN:-$(gloo_config PROXY_AUTH_TOKEN)}"
GLOO_PROXY_TOKEN="${GLOO_PROXY_TOKEN:-local}"

gloo_healthy() { curl -fsS --max-time 1 "$GLOO_PROXY_URL/health" >/dev/null 2>&1; }

gloo_stop_proxy() {
  local pids
  if ! curl -fsS --max-time 1 "$GLOO_PROXY_URL/health" 2>/dev/null | grep -q '"upstream"'; then
    echo "Gloo proxy was not running"
    return 0
  fi
  pids="$(lsof -ti "tcp:$GLOO_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids && echo "Gloo proxy stopped"
  else
    echo "Gloo proxy was not running"
  fi
}

gloo_ensure_proxy() {
  gloo_healthy && return 0
  if ! command -v node >/dev/null 2>&1; then
    echo "glooai: Node.js 24+ is required (https://nodejs.org)" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$GLOO_LOG")"
  (
    cd "$GLOO_ROOT"
    for fd in $(ls /dev/fd); do ((fd > 2)) && eval "exec $fd>&-" 2>/dev/null; done
    nohup node --disable-warning=ExperimentalWarning --env-file-if-exists="$GLOO_CONFIG_FILE" \
      "$GLOO_ROOT/src/server.ts" </dev/null >>"$GLOO_LOG" 2>&1 &
  )
  for _ in $(seq 1 50); do
    gloo_healthy && return 0
    sleep 0.2
  done
  echo "glooai: proxy failed to start at $GLOO_PROXY_URL; last log lines from $GLOO_LOG:" >&2
  tail -5 "$GLOO_LOG" >&2
  exit 1
}

# Handles flags shared by both commands. Returns 1 when the flag is not one of ours.
gloo_common_flag() {
  case "${1:-}" in
    --stop-proxy) gloo_stop_proxy ;;
    --proxy-log) exec tail -f "$GLOO_LOG" ;;
    --update)
      git -C "$GLOO_ROOT" pull --ff-only
      gloo_stop_proxy
      ;;
    *) return 1 ;;
  esac
}
