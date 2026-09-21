#!/usr/bin/env bash
#
# graphify-local.sh — build, verify, or clean the codebase knowledge graph
# WITHOUT a GitHub Actions runner.
#
# This is now the ONLY way the graph gets built: graphify-out/ is gitignored and
# there is no graphify CI workflow (#1152). AST-only: no LLM calls, no API keys,
# $0 cost. Output stays on your machine and is never committed.
#
# Subcommands:
#   build            Build/refresh graphify-out/ and KEEP it (default).
#   verify           Build to confirm graphify works, validate the output, then
#                    DELETE graphify-out/ again (leaves no artifacts behind —
#                    use this in tests / smoke checks).
#   clean            Delete the repo's root-level scratch files (UI-vision /
#                    walkthrough / retest screenshots, console logs, coverage
#                    dumps). Tracked files are removed via `git rm`.
#   help             Show this message.
#
# Usage:
#   scripts/graphify-local.sh [build|verify|clean]
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="graphify-out"
BUILD_SCRIPT="scripts/graphify-ast-build.py"
GRAPHIFY_VERSION="0.5.6"

log()  { printf '\033[36m[graphify-local]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[graphify-local]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[graphify-local]\033[0m %s\n' "$*" >&2; exit 1; }

# Root-level scratch file globs. These are throwaway artifacts produced by the
# UI Vision / retest walkthroughs and ad-hoc coverage runs. They inflate every
# directory scan an AI agent does, so we keep them out of the tree.
scratch_globs() {
  cat <<'EOF'
uv-*.png
uv-*.md
uv-*.yml
uv-*.log
retest-*.png
retest-*.md
retest-*.yml
retest-*.txt
retest-console-*.txt
metis-retest-*.png
metis-retest-*.yml
walkthrough-*.png
step*.png
project-overview-*.png
mcp-settings-*.png
projects-page.png
0[0-9]-*.png
tmp-ui-vision-*.md
coverage_output*.txt
coverage_full*.txt
issues_output.txt
run_log.txt
server_coverage.txt
test_output.txt
ui_test_output.txt
test_results.log
get_summary.py
EOF
}

# Resolve how to invoke the AST build script. The script imports the `graphify`
# Python package, so it must run inside an environment where that package is
# importable. Preference order: uv (isolated tool env) → existing importable
# python → install via uv/pipx/pip.
graphify_runner() {
  if command -v uv >/dev/null 2>&1; then
    echo "uv tool run --from graphifyy==${GRAPHIFY_VERSION} python -u"
    return 0
  fi
  if command -v python3 >/dev/null 2>&1 && python3 -c "import graphify" >/dev/null 2>&1; then
    echo "python3 -u"
    return 0
  fi
  return 1
}

ensure_graphify() {
  if graphify_runner >/dev/null 2>&1; then
    return 0
  fi
  warn "graphify not available — attempting install…"
  if command -v uv >/dev/null 2>&1; then
    uv tool install "graphifyy==${GRAPHIFY_VERSION}"
  elif command -v pipx >/dev/null 2>&1; then
    pipx install "graphifyy==${GRAPHIFY_VERSION}"
  elif command -v pip >/dev/null 2>&1; then
    pip install "graphifyy==${GRAPHIFY_VERSION}"
  else
    die "No uv, pipx, or pip found. Install one, or see https://github.com/safishamsi/graphify."
  fi
}

do_build() {
  ensure_graphify
  local runner; runner="$(graphify_runner)" || die "graphify still unavailable after install."
  log "building graph via: ${runner} ${BUILD_SCRIPT}"
  # shellcheck disable=SC2086
  ${runner} "${BUILD_SCRIPT}"
  log "graph written to ${OUT_DIR}/ (graph.json + GRAPH_REPORT.md)"
}

validate_output() {
  [[ -f "${OUT_DIR}/graph.json" ]]        || die "missing ${OUT_DIR}/graph.json"
  [[ -f "${OUT_DIR}/GRAPH_REPORT.md" ]]   || die "missing ${OUT_DIR}/GRAPH_REPORT.md"
  local size; size=$(wc -c < "${OUT_DIR}/graph.json")
  [[ "${size}" -gt 1000 ]] || die "graph.json is suspiciously small (${size} bytes)"
  grep -q '"nodes"' "${OUT_DIR}/graph.json" || die "graph.json has no nodes array"
  log "validation PASS — graph.json=${size} bytes, report present"
}

do_verify() {
  local preexisting="no"
  [[ -e "${OUT_DIR}" ]] && preexisting="yes"
  do_build
  validate_output
  if [[ "${preexisting}" == "yes" ]]; then
    warn "graphify-out/ existed before verify; leaving it in place to avoid clobbering a real graph."
  else
    log "verify mode — removing test-only ${OUT_DIR}/"
    rm -rf "${OUT_DIR}"
  fi
  log "VERIFY OK"
}

do_clean() {
  local removed=0
  while IFS= read -r glob; do
    [[ -z "${glob}" ]] && continue
    # Root-level only (maxdepth 1); never descend into source dirs.
    while IFS= read -r -d '' f; do
      f="${f#./}"
      if git ls-files --error-unmatch "${f}" >/dev/null 2>&1; then
        git rm -q -f "${f}"
      else
        rm -f "${f}"
      fi
      removed=$((removed + 1))
    done < <(find . -maxdepth 1 -type f -name "${glob}" -print0 2>/dev/null)
  done < <(scratch_globs)
  log "removed ${removed} root-level scratch file(s)"
  [[ "${removed}" -gt 0 ]] && warn "tracked deletions are staged; commit them to finalize."
}

cmd="${1:-build}"
case "${cmd}" in
  build)  do_build ;;
  verify) do_verify ;;
  clean)  do_clean ;;
  help|-h|--help)
    awk 'NR>1 { if ($0 ~ /^#/) { sub(/^# ?/, ""); print } else { exit } }' "${BASH_SOURCE[0]}"
    ;;
  *) die "unknown subcommand '${cmd}'. Try: build | verify | clean | help" ;;
esac
