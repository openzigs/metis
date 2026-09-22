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
#   SERVER_PORT  default 4000   — stop the METIS process bound here
#   UI_PORT      default 3000   — stop the METIS process bound here
#   STOP_GRACE_SECS default 5   — SIGTERM grace before SIGKILL
#
# Notes:
#   - Only processes METIS started are stopped (#24): a process on a METIS
#     port or matching a dev argv pattern counts only when its working
#     directory is inside this checkout; every descendant of such a process
#     is stopped with it; and so is any process carrying this checkout's
#     owner tag (METIS_SIDECAR_OWNER, exported to `pnpm dev` below and
#     stamped onto every MCP sidecar by `server/src/lib/mcp/stdio-transport.ts`),
#     which is how a sidecar orphaned by a dead server is still found. Other
#     tools' MCP servers, and dev servers of other projects, are never touched.
#   - Smoke test (--detached only): after the server passes /healthz, the
#     script runs a login → create-session → chat request. This forces the
#     AI SDK to initialise a fresh connection on the new process, preventing
#     the CAPIError: Connection error that occurs when a stale SDK singleton
#     from a previous server process is reused on the first real request.
#   - This script ONLY targets dev processes. Production deployments should
#     use `docker compose down && docker compose up -d` instead.
# ==============================================================================

set -euo pipefail

# #24 — the script must not START with METIS_SIDECAR_OWNER set: a forked
# subshell reports the environment its process was exec'd with, so every
# subshell of the sweep would match its own tag. Re-exec without it (before
# the `cd`, while a relative "$0" still resolves).
if [ -n "${METIS_SIDECAR_OWNER+x}" ]; then
  exec env -u METIS_SIDECAR_OWNER bash "${BASH_SOURCE[0]}" "$@"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"

# Per-checkout owner tag (#24), exported only into the `pnpm dev` this script
# launches (start_stack) and stamped onto every MCP sidecar by the server.
SIDECAR_OWNER="metis-$(printf '%s' "$REPO_ROOT" | cksum | awk '{print $1}')"

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
      sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
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
# process_cwd <pid> — the process's working directory, or empty if unknown
# ----------------------------------------------------------------------------
process_cwd() {
  local pid="$1"
  if [ -e "/proc/$pid/cwd" ]; then
    readlink "/proc/$pid/cwd" 2>/dev/null || true
  elif command -v lsof >/dev/null 2>&1; then
    { lsof -a -p "$pid" -d cwd -Fn 2>/dev/null || true; } | sed -n 's/^n//p' | head -n 1
  fi
}

# ----------------------------------------------------------------------------
# runs_in_repo <pid> — true when the process's cwd is inside this checkout
# ----------------------------------------------------------------------------
runs_in_repo() {
  local cwd
  cwd="$(process_cwd "$1")"
  [ -n "$cwd" ] || return 1
  case "$cwd/" in
    "$REPO_ROOT"/*) return 0 ;;
  esac
  return 1
}

# ----------------------------------------------------------------------------
# pids_with_owner_tag — processes whose ENVIRONMENT carries this checkout's
# METIS_SIDECAR_OWNER tag (argv is never consulted, so a command line that
# merely mentions the tag does not match).
# ----------------------------------------------------------------------------
pids_with_owner_tag() {
  local marker="METIS_SIDECAR_OWNER=$SIDECAR_OWNER"
  if [ -r /proc/self/environ ]; then
    local f pid kv
    for f in /proc/[0-9]*/environ; do
      [ -r "$f" ] || continue
      pid="${f#/proc/}"
      pid="${pid%/environ}"
      while IFS= read -r -d '' kv; do
        if [ "$kv" = "$marker" ]; then
          echo "$pid"
          break
        fi
      done 2>/dev/null <"$f" || true
    done
  else
    # BSD/macOS: `ps -E` appends the environment after the argv. Take the argv
    # from a plain `ps` and look for the tag only in what follows it.
    awk -v m="$marker" '
      NR == FNR { p = $1; sub(/^[ \t]*[0-9]+ /, ""); argv[p] = $0; next }
      {
        p = $1; line = $0; sub(/^[ \t]*[0-9]+ /, "", line)
        if (!(p in argv)) next
        a = argv[p]
        if (substr(line, 1, length(a)) != a) next
        if (index(" " substr(line, length(a) + 1) " ", " " m " ")) print p
      }
    ' <(ps -A -ww -o pid=,command= 2>/dev/null || true) \
      <(ps -E -A -ww -o pid=,command= 2>/dev/null || true)
  fi
}

# ----------------------------------------------------------------------------
# descendants_of <pid...> — every process below the given ones in the tree
# ----------------------------------------------------------------------------
descendants_of() {
  [ "$#" -eq 0 ] && return 0
  { ps -A -o pid= -o ppid= 2>/dev/null || true; } | awk -v roots="$*" '
    BEGIN { n = split(roots, r, " "); for (i = 1; i <= n; i++) keep[r[i]] = 1 }
    { parent[$1] = $2 }
    END {
      changed = 1
      while (changed) {
        changed = 0
        for (p in parent) if (!(p in keep) && (parent[p] in keep)) { keep[p] = 1; out[p] = 1; changed = 1 }
      }
      for (p in out) print p
    }'
}

# ----------------------------------------------------------------------------
# ancestors_of <pid> — the pid and every process above it
# ----------------------------------------------------------------------------
ancestors_of() {
  { ps -A -o pid= -o ppid= 2>/dev/null || true; } | awk -v start="$1" '
    { parent[$1] = $2 }
    END { p = start; while (p != "" && p != 0 && !(p in seen)) { seen[p] = 1; print p; p = parent[p] } }'
}

# ----------------------------------------------------------------------------
# collect_stop_pids — print the PIDs METIS itself started, one per line (#24)
# ----------------------------------------------------------------------------
collect_stop_pids() {
  # 1. Candidates: whatever holds a METIS port, plus the dev orchestration and
  #    app argv patterns (server tsx, next dev, pnpm dev wrapper). These
  #    patterns match other projects too, so a candidate only counts when it
  #    runs inside this checkout.
  local candidates=()
  while IFS= read -r p; do [ -n "$p" ] && candidates+=("$p"); done < <(pids_on_port "$SERVER_PORT")
  while IFS= read -r p; do [ -n "$p" ] && candidates+=("$p"); done < <(pids_on_port "$UI_PORT")
  while IFS= read -r p; do [ -n "$p" ] && candidates+=("$p"); done < <(pids_matching 'tsx[^/]* (watch )?src/index\.ts')
  while IFS= read -r p; do [ -n "$p" ] && candidates+=("$p"); done < <(pids_matching 'next-server.*\(dev\)')
  while IFS= read -r p; do [ -n "$p" ] && candidates+=("$p"); done < <(pids_matching 'next dev')
  while IFS= read -r p; do [ -n "$p" ] && candidates+=("$p"); done < <(pids_matching 'pnpm.*--filter ./server.*dev')
  while IFS= read -r p; do [ -n "$p" ] && candidates+=("$p"); done < <(pids_matching 'pnpm.*--filter ./ui.*dev')
  while IFS= read -r p; do [ -n "$p" ] && candidates+=("$p"); done < <(pids_matching 'metis.*pnpm dev')

  local roots=()
  if [ "${#candidates[@]}" -gt 0 ]; then
    for p in "${candidates[@]}"; do
      runs_in_repo "$p" && roots+=("$p")
    done
  fi

  # 2. Everything METIS started: those roots, their whole process trees (MCP
  #    sidecars included), and any process carrying this checkout's owner tag
  #    (a sidecar orphaned by a server that already died).
  local raw_pids=()
  if [ "${#roots[@]}" -gt 0 ]; then
    raw_pids+=("${roots[@]}")
    while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(descendants_of "${roots[@]}")
  fi
  while IFS= read -r p; do [ -n "$p" ] && raw_pids+=("$p"); done < <(pids_with_owner_tag)

  # 3. De-dup and exclude this script and everything above it.
  # Use a space-delimited string for seen tracking (bash 3.2 compatible —
  # macOS ships bash 3.2 which does not support declare -A).
  # Guard the array expansion with a length check: in bash < 4.4, expanding
  # an empty array with [@] under set -u triggers "unbound variable".
  local seen_pids=" "
  local p
  while IFS= read -r p; do [ -n "$p" ] && seen_pids="$seen_pids$p "; done < <(ancestors_of "$$")
  seen_pids="$seen_pids$PPID "
  if [ "${#raw_pids[@]}" -gt 0 ]; then
    for p in "${raw_pids[@]}"; do
      [ -z "$p" ] && continue
      [[ "$seen_pids" == *" $p "* ]] && continue
      seen_pids="$seen_pids$p "
      echo "$p"
    done
  fi
}

# ----------------------------------------------------------------------------
# stop_stack — TERM then KILL every process METIS started
# ----------------------------------------------------------------------------
stop_stack() {
  log "stopping running METIS dev processes..."

  local pids=()
  while IFS= read -r p; do [ -n "$p" ] && pids+=("$p"); done < <(collect_stop_pids)

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

  # Re-check ports. A holder that is not METIS's was never signalled.
  for port in "$SERVER_PORT" "$UI_PORT"; do
    local still
    still="$(pids_on_port "$port" | tr '\n' ' ')"
    if [ -n "${still// /}" ]; then
      log "WARN: port $port still bound by: $still(not stopped unless started from $REPO_ROOT)"
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
    export METIS_SIDECAR_OWNER="$SIDECAR_OWNER"
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
    export METIS_SIDECAR_OWNER="$SIDECAR_OWNER"
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
