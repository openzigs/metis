#!/usr/bin/env bash
# ==============================================================================
# METIS Backup Script
#
# Creates a timestamped tarball containing:
#   - Database dump (sqlite copy or pg_dump custom format)
#   - server/data/uploads/   (user-uploaded documents)
#   - server/data/lancedb/   (vector store, if present)
#
# Usage:
#   ./scripts/backup.sh                  # default output dir: ./backups
#   ./scripts/backup.sh /path/to/dir     # explicit output dir
#
# Environment:
#   DATABASE_URL          (required) — Prisma connection string
#   DATABASE_PROVIDER     sqlite | postgresql (default sqlite)
#   BACKUP_DIR            output dir override (default ./backups)
#   BACKUP_RETENTION_DAYS prune backups older than N days (default 30, 0 disables)
#   UPLOAD_DIR            uploads source dir (default $REPO_ROOT/server/data/uploads)
#   LANCEDB_PATH          lancedb source dir (default $REPO_ROOT/server/data/lancedb)
#
# UPLOAD_DIR / LANCEDB_PATH: when set, the backup reads the application data
# from these env-configured directories instead of the in-repo defaults. This
# lets deployments that relocate their stores (e.g. a mounted volume) be backed
# up without operator workarounds. The TARBALL'S INTERNAL LAYOUT IS UNCHANGED —
# the archive always stores them under data/uploads and data/lancedb so existing
# archives remain restorable.
#
# Restore with: ./scripts/restore.sh <tarball>
# ==============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT_DIR="${1:-${BACKUP_DIR:-./backups}}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$(mktemp -d -t metis-backup-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

PROVIDER="${DATABASE_PROVIDER:-sqlite}"
DATABASE_URL_VAL="${DATABASE_URL:-file:./dev.db}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$OUT_DIR"
mkdir -p "$WORK_DIR/db" "$WORK_DIR/data"

echo "[backup] timestamp=$TIMESTAMP provider=$PROVIDER out=$OUT_DIR"

# ----- Database dump --------------------------------------------------------
case "$PROVIDER" in
  sqlite)
    # Strip "file:" prefix if present. A RELATIVE file: path is resolved against
    # server/ — that is the app's CWD at runtime (server/package.json runs
    # `tsx --env-file=../.env src/index.ts` from server/, and the
    # better-sqlite3 adapter opens a relative file: URL relative to process.cwd()),
    # so `file:./dev.db` is the real DB at server/dev.db, NOT server/prisma/dev.db.
    # ABSOLUTE file:/... paths are used verbatim.
    SQLITE_PATH="${DATABASE_URL_VAL#file:}"
    if [[ "$SQLITE_PATH" != /* ]]; then
      SQLITE_PATH="$REPO_ROOT/server/$SQLITE_PATH"
    fi
    echo "[backup] sqlite source: $SQLITE_PATH"
    if [[ ! -f "$SQLITE_PATH" ]]; then
      echo "[backup] ERROR: sqlite db not found at $SQLITE_PATH" >&2
      exit 1
    fi
    # Empty-DB guard: a 0-table database almost always means we resolved the
    # wrong path (or the DB was never migrated). Warn LOUDLY but do not fail —
    # a legitimately empty DB is possible. Silent empty backups must be impossible.
    if command -v sqlite3 >/dev/null 2>&1; then
      TABLE_COUNT="$(sqlite3 "$SQLITE_PATH" "SELECT count(*) FROM sqlite_master WHERE type='table'" 2>/dev/null || echo "")"
      if [[ "$TABLE_COUNT" == "0" ]]; then
        {
          echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
          echo "!!! [backup] WARNING: sqlite database appears EMPTY (0 tables)"
          echo "!!! path: $SQLITE_PATH"
          echo "!!! This backup may be USELESS. Verify DATABASE_URL resolves to the"
          echo "!!! real database (relative file: paths resolve against server/)."
          echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
        } >&2
      fi
    else
      echo "[backup] note: sqlite3 CLI unavailable — skipping empty-DB table count check" >&2
    fi
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$SQLITE_PATH" ".backup '$WORK_DIR/db/metis.sqlite'"
    else
      echo "[backup] sqlite3 CLI not found — falling back to file copy" >&2
      cp "$SQLITE_PATH" "$WORK_DIR/db/metis.sqlite"
    fi
    ;;
  postgresql|postgres)
    if ! command -v pg_dump >/dev/null 2>&1; then
      echo "[backup] ERROR: pg_dump not in PATH" >&2
      exit 1
    fi
    pg_dump --format=custom --no-owner --no-privileges \
      --file="$WORK_DIR/db/metis.dump" "$DATABASE_URL_VAL"
    ;;
  *)
    echo "[backup] ERROR: unsupported DATABASE_PROVIDER=$PROVIDER" >&2
    exit 1
    ;;
esac

# ----- Application data -----------------------------------------------------
# Honor UPLOAD_DIR / LANCEDB_PATH when set; otherwise fall back to the in-repo
# defaults. The tarball ALWAYS stores them under data/uploads and data/lancedb
# (stable internal layout — see restore.sh, which copies back out to the
# env-configured dirs).
UPLOADS_SRC="${UPLOAD_DIR:-$REPO_ROOT/server/data/uploads}"
LANCEDB_SRC="${LANCEDB_PATH:-$REPO_ROOT/server/data/lancedb}"

if [[ -d "$UPLOADS_SRC" ]]; then
  cp -R "$UPLOADS_SRC" "$WORK_DIR/data/uploads"
fi
if [[ -d "$LANCEDB_SRC" ]]; then
  cp -R "$LANCEDB_SRC" "$WORK_DIR/data/lancedb"
fi

# Manifest
cat > "$WORK_DIR/MANIFEST.json" <<EOF
{
  "timestamp": "$TIMESTAMP",
  "provider": "$PROVIDER",
  "schemaVersion": "$(cat "$REPO_ROOT/package.json" | grep '"version"' | head -1 | sed -E 's/.*"version": "([^"]+)".*/\1/')",
  "host": "$(hostname)"
}
EOF

# ----- Tarball + integrity checksum ----------------------------------------
TARBALL="$OUT_DIR/metis-backup-$TIMESTAMP.tar.gz"
tar -czf "$TARBALL" -C "$WORK_DIR" .
( cd "$OUT_DIR" && shasum -a 256 "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256" )

echo "[backup] wrote $TARBALL"
echo "[backup] sha256 $(cat "$TARBALL.sha256")"

# ----- Retention pruning ----------------------------------------------------
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  find "$OUT_DIR" -maxdepth 1 -name 'metis-backup-*.tar.gz' -type f \
    -mtime +"$RETENTION_DAYS" -print -delete || true
  find "$OUT_DIR" -maxdepth 1 -name 'metis-backup-*.tar.gz.sha256' -type f \
    -mtime +"$RETENTION_DAYS" -print -delete || true
fi

echo "[backup] done"
