#!/usr/bin/env bash
# ==============================================================================
# METIS Restart Script
#
# Stops any running instances of the METIS dev stack (server, UI, and any
# spawned MCP stdio sidecar children) and restarts `pnpm dev` from a clean
# slate.
#
# Usage:
#   ./scripts/restart.sh              # stop + restart in foreground
#   ./scripts/restart.sh --stop-only  # only stop, do not restart
#   ./scripts/restart.sh --detached   # restart in background, log to ./logs/dev.log
#
# Environment:
#   SERVER_PORT  default 4000   — kill anything bound here
#   UI_PORT      default 3000   — kill anything bound here
#   STOP_GRACE_SECS default 5   — SIGTERM grace before SIGKILL
#
# Notes:
#   - Sidecars: `server/src/lib/mcp/stdio-transport.ts` spawns MCP child
#     processes (npx, uvx, docker, etc.). They are children of the server
#     and will be torn down when the server exits, but we also sweep for
#     orphans by parent-pid and known argv patterns.
#   - Smoke test (--detached only): after the server passes /healthz, the
#     script runs a login → create-session → chat request. This forces the
#     AI SDK to initialise a fresh connection on the new process, preventing
#     the CAPIError: Connection error that occurs when a stale SDK singleton
#     from a previous server process is reused on the first real request.
#   - This script ONLY targets dev processes. Production deployments should
#     use `docker compose down && docker compose up -d` instead.
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SERVER_PORT="${SERVER_PORT:-4000}"
UI_PORT="${UI_PORT:-3000}"
STOP_GRACE_SECS="${STOP_GRACE_SECS:-5}"

STOP_ONLY=0
DETACHED=0
for arg in "$@"; do
  case "$arg" in
    --stop-only) STOP_ONLY=1 ;;
    --detached|--background|-d) DETACHED=1 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '[restart] %s\n' "$*"; }

# ----------------------------------------------------------------------------
# kill_pids <signal> <pid...>
# ----------------------------------------------------------------------------
kill_pids() {
  local sig="$1"
  shift
  [ "$#" -eq 0 ] && return 0
  for pid in "$@"; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
      kill "-$sig" "$pid" 2>/dev/null || true
    fi
  done
}

# ----------------------------------------------------------------------------
# pids_on_port <port>
# ----------------------------------------------------------------------------
pids_on_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  elif command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$port" 2>/dev/null | tr -d ':' || true
  fi
}

# ----------------------------------------------------------------------------
# pids_matching <pgrep-pattern>
# ----------------------------------------------------------------------------
pids_matching() {
  local pattern="$1"
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -f "$pattern" 2>/dev/null || true
  else
    # Fallback for systems without pgrep
    ps -eo pid=,args= 2>/dev/null \
      | awk -v p="$pattern" '$0 ~ p { print $1 }' || true
  fi
}

# ----------------------------------------------------------------------------
# stop_stack — TERM then KILL across ports + known argv patterns
# ----------------------------------------------------------------------------
stop_stack() {
  log "stopping running METIS dev processes..."

  # 1. Collect candidate PIDs.
  local raw_pids=()
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_on_port "$SERVER_PORT")
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_on_port "$UI_PORT")

  # Dev orchestration & app processes (server tsx, next dev, pnpm dev wrapper).
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_matching 'tsx[^/]* (watch )?src/index\.ts')
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_matching 'next-server.*\(dev\)')
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_matching 'next dev')
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_matching 'pnpm.*--filter ./server.*dev')
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_matching 'pnpm.*--filter ./ui.*dev')
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_matching 'metis.*pnpm dev')

  # MCP stdio sidecars spawned by the server (npx-based MCP servers, etc.).
  # Match anything explicitly tagged as a metis-spawned MCP child via argv.
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_matching 'modelcontextprotocol|@modelcontextprotocol|mcp-server-')

  # 2. De-dup and exclude this script + its parent shell.
  # Use a space-delimited string for seen tracking (bash 3.2 compatible —
  # macOS ships bash 3.2 which does not support declare -A).
  # Guard the array expansion with a length check: in bash < 4.4, expanding
  # an empty array with [@] under set -u triggers "unbound variable".
  local self_pid=$$
  local parent_pid=$PPID
  local pids=()
  local seen_pids=" "
  if [ "${#raw_pids[@]}" -gt 0 ]; then
    for p in "${raw_pids[@]}"; do
      [ -z "$p" ] && continue
      [ "$p" = "$self_pid" ] && continue
      [ "$p" = "$parent_pid" ] && continue
      [[ " $seen_pids " == *" $p "* ]] && continue
      seen_pids="$seen_pids$p "
      pids+=("$p")
    done
  fi

  if [ "${#pids[@]}" -eq 0 ]; then
    log "no running METIS processes found"
    return 0
  fi

  log "sending SIGTERM to: ${pids[*]}"
  kill_pids TERM "${pids[@]}"

  # Grace window
  local elapsed=0
  while [ "$elapsed" -lt "$STOP_GRACE_SECS" ]; do
    local alive=0
    for pid in "${pids[@]}"; do
      kill -0 "$pid" 2>/dev/null && alive=1
    done
    [ "$alive" -eq 0 ] && break
    sleep 1
    elapsed=$((elapsed + 1))
  done

  # Force-kill stragglers
  local survivors=()
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      survivors+=("$pid")
    fi
  done
  if [ "${#survivors[@]}" -gt 0 ]; then
    log "SIGKILL stragglers: ${survivors[*]}"
    kill_pids KILL "${survivors[@]}"
  fi

  # Re-check ports
  for port in "$SERVER_PORT" "$UI_PORT"; do
    local still
    still="$(pids_on_port "$port")"
    if [ -n "$still" ]; then
      log "WARN: port $port still bound by: $still"
    fi
  done

  log "stop complete"
}

# ----------------------------------------------------------------------------
# wait_for_server — poll /healthz until the server is accepting connections
# ----------------------------------------------------------------------------
wait_for_server() {
  local timeout=30
  local elapsed=0
  log "waiting for server on port $SERVER_PORT..."
  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -sf "http://localhost:${SERVER_PORT}/healthz" >/dev/null 2>&1; then
      log "server is up"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  log "WARN: server did not respond to /healthz within ${timeout}s"
  return 1
}

# ----------------------------------------------------------------------------
# smoke_test — login → create session → send a chat message → verify response
# Clears the SDK singleton connection so the first real request succeeds.
# ----------------------------------------------------------------------------
smoke_test() {
  log "running chat smoke test..."

  local token
  token=$(curl -sf "http://localhost:${SERVER_PORT}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"password"}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['accessToken'])" 2>/dev/null) || {
    log "WARN: smoke test — login failed (check AUTH_MODE in .env)"
    return 1
  }

  local session_id
  session_id=$(curl -sf -X POST "http://localhost:${SERVER_PORT}/api/ai/sessions" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d '{}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['session']['id'])" 2>/dev/null) || {
    log "WARN: smoke test — session creation failed"
    return 1
  }

  local content
  content=$(curl -sf -X POST "http://localhost:${SERVER_PORT}/api/ai/chat" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: application/json" \
    -d "{\"sessionId\":\"$session_id\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); c=d.get('data',{}).get('response',{}).get('content',''); print(c[:80] if c else 'EMPTY')" 2>/dev/null) || {
    log "WARN: smoke test — chat request failed"
    return 1
  }

  if [ -z "$content" ] || [ "$content" = "EMPTY" ]; then
    log "WARN: smoke test — got empty response (provider may be unreachable)"
    return 1
  fi

  log "smoke test PASSED — \"${content}\""
}

# ----------------------------------------------------------------------------
# start_stack
# ----------------------------------------------------------------------------
start_stack() {
  if [ ! -d node_modules ]; then
    log "node_modules missing — running pnpm install --frozen-lockfile"
    pnpm install --frozen-lockfile
  fi

  # server/ui import @metis/shared's built dist, not its source — a stale dist
  # (e.g. after a pull that added an export) crashes the server at boot with
  # "does not provide an export named ...". Always rebuild before launch.
  log "building @metis/shared..."
  pnpm --filter @metis/shared run build

  if [ "$DETACHED" -eq 1 ]; then
    mkdir -p logs
    local log_file="logs/dev.log"
    log "starting pnpm dev in background (logs: $log_file)"
    nohup pnpm dev >"$log_file" 2>&1 &
    local dev_pid=$!
    disown "$dev_pid" 2>/dev/null || true
    log "started (pid=$dev_pid)"
    log "tail with: tail -f $log_file"
    # Verify the server came up cleanly and the AI provider connection is fresh.
    if wait_for_server; then
      smoke_test || log "smoke test failed — check logs/$log_file for details"
    fi
  else
    log "starting pnpm dev (Ctrl-C to stop)"
    exec pnpm dev
  fi
}

# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
stop_stack

if [ "$STOP_ONLY" -eq 1 ]; then
  exit 0
fi

start_stack
