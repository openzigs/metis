#!/usr/bin/env bash
# ==============================================================================
# METIS Restore Script
#
# Restores a backup tarball produced by `scripts/backup.sh`:
#   - Verifies sha256 if a .sha256 sidecar is present.
#   - Restores DB to the path/connection from $DATABASE_URL.
#   - Restores server/data/uploads/ and server/data/lancedb/.
#
# Usage:
#   ./scripts/restore.sh ./backups/metis-backup-YYYYMMDDTHHMMSSZ.tar.gz
#
# Environment:
#   DATABASE_URL      (required) — Prisma connection string
#   DATABASE_PROVIDER sqlite | postgresql (default sqlite)
#   UPLOAD_DIR        uploads destination dir (default $REPO_ROOT/server/data/uploads)
#   LANCEDB_PATH      lancedb destination dir (default $REPO_ROOT/server/data/lancedb)
#
# UPLOAD_DIR / LANCEDB_PATH: the tarball always stores app data under
# data/uploads and data/lancedb (stable internal layout). On restore, that data
# is copied back OUT to these env-configured directories when set; the parent
# directories are created as needed. Existing archives (made before relocation)
# restore unchanged because only the destination path is parameterized.
#
# WARNING: this overwrites the live database. Stop the server first.
# ==============================================================================

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <tarball>" >&2
  exit 2
fi

TARBALL="$1"
if [[ ! -f "$TARBALL" ]]; then
  echo "[restore] ERROR: tarball not found: $TARBALL" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROVIDER="${DATABASE_PROVIDER:-sqlite}"
DATABASE_URL_VAL="${DATABASE_URL:-file:./dev.db}"

WORK_DIR="$(mktemp -d -t metis-restore-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# ----- Integrity check ------------------------------------------------------
if [[ -f "$TARBALL.sha256" ]]; then
  echo "[restore] verifying sha256"
  ( cd "$(dirname "$TARBALL")" && shasum -a 256 -c "$(basename "$TARBALL").sha256" )
fi

# ----- Extract --------------------------------------------------------------
tar -xzf "$TARBALL" -C "$WORK_DIR"

if [[ -f "$WORK_DIR/MANIFEST.json" ]]; then
  echo "[restore] manifest:"
  cat "$WORK_DIR/MANIFEST.json"
fi

# ----- Database restore -----------------------------------------------------
case "$PROVIDER" in
  sqlite)
    # A RELATIVE file: path resolves against server/ — the app's CWD at runtime
    # (so `file:./dev.db` is server/dev.db, NOT server/prisma/dev.db). ABSOLUTE
    # file:/... paths are used verbatim.
    SQLITE_PATH="${DATABASE_URL_VAL#file:}"
    if [[ "$SQLITE_PATH" != /* ]]; then
      SQLITE_PATH="$REPO_ROOT/server/$SQLITE_PATH"
    fi
    if [[ ! -f "$WORK_DIR/db/metis.sqlite" ]]; then
      echo "[restore] ERROR: db/metis.sqlite not in tarball" >&2
      exit 1
    fi
    echo "[restore] sqlite target: $SQLITE_PATH"
    mkdir -p "$(dirname "$SQLITE_PATH")"
    cp "$WORK_DIR/db/metis.sqlite" "$SQLITE_PATH"
    echo "[restore] sqlite restored to $SQLITE_PATH"
    ;;
  postgresql|postgres)
    if ! command -v pg_restore >/dev/null 2>&1; then
      echo "[restore] ERROR: pg_restore not in PATH" >&2
      exit 1
    fi
    if [[ ! -f "$WORK_DIR/db/metis.dump" ]]; then
      echo "[restore] ERROR: db/metis.dump not in tarball" >&2
      exit 1
    fi
    pg_restore --clean --if-exists --no-owner --no-privileges \
      --dbname="$DATABASE_URL_VAL" "$WORK_DIR/db/metis.dump"
    echo "[restore] postgres restored"
    ;;
  *)
    echo "[restore] ERROR: unsupported DATABASE_PROVIDER=$PROVIDER" >&2
    exit 1
    ;;
esac

# ----- Application data -----------------------------------------------------
# Honor UPLOAD_DIR / LANCEDB_PATH when set; otherwise fall back to the in-repo
# defaults. The tarball's internal layout (data/uploads, data/lancedb) is fixed;
# we copy it back OUT to the env-configured destinations, creating the parent
# directory as needed.
# Fall back to in-repo defaults only when the var is UNSET (use ${VAR-default},
# not ${VAR:-default}), so an explicitly-set-but-empty value still reaches the
# guard below and is refused rather than silently using the default.
UPLOADS_DEST="${UPLOAD_DIR-$REPO_ROOT/server/data/uploads}"
LANCEDB_DEST="${LANCEDB_PATH-$REPO_ROOT/server/data/lancedb}"

# Blast-radius guard: a misconfigured UPLOAD_DIR/LANCEDB_PATH (empty, "/", $HOME,
# or relative) would make `rm -rf` below delete the wrong tree. Refuse those.
assert_safe_dest() {
  local label="$1" dest="$2"
  if [[ -z "$dest" || "$dest" != /* || "$dest" == "/" || "$dest" == "$HOME" ]]; then
    echo "[restore] ERROR: refusing to delete $label destination '$dest' — must be an absolute path and not '/' or \$HOME" >&2
    exit 1
  fi
}
assert_safe_dest "uploads" "$UPLOADS_DEST"
assert_safe_dest "lancedb" "$LANCEDB_DEST"

if [[ -d "$WORK_DIR/data/uploads" ]]; then
  rm -rf "$UPLOADS_DEST"
  mkdir -p "$(dirname "$UPLOADS_DEST")"
  cp -R "$WORK_DIR/data/uploads" "$UPLOADS_DEST"
  echo "[restore] uploads restored to $UPLOADS_DEST"
fi
if [[ -d "$WORK_DIR/data/lancedb" ]]; then
  rm -rf "$LANCEDB_DEST"
  mkdir -p "$(dirname "$LANCEDB_DEST")"
  cp -R "$WORK_DIR/data/lancedb" "$LANCEDB_DEST"
  echo "[restore] lancedb restored to $LANCEDB_DEST"
fi

echo "[restore] done — restart the server"
