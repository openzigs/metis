#!/bin/sh
# ==============================================================================
# METIS dev-mode server entrypoint (issue #390)
#
# Runs at container start before the main process. Idempotent — safe to invoke
# on every restart.
#
#   1. Detect DB provider from DATABASE_URL (postgresql:// vs file:).
#   2. Select the matching schema + migrations dir:
#        - sqlite      -> prisma/schema.prisma + prisma/migrations
#        - postgresql  -> prisma/postgres/schema.prisma + prisma/postgres/migrations
#   3. Ensure the SQLite data dir exists (no-op for postgres).
#   4. Apply pending migrations via `prisma migrate deploy`.
#   5. Seed if the User table is empty.
#   6. Exec the CMD (typically `node server/dist/index.js`).
#
# Failures in step 4/5 are FATAL — there is no point starting the server
# against a half-initialised schema.
# ==============================================================================

set -e

DATA_DIR="${DATA_DIR:-/app/data}"
DB_FILE="${DB_FILE:-${DATA_DIR}/dev.db}"

# Default DATABASE_URL points at the SQLite volume.
if [ -z "${DATABASE_URL}" ]; then
  export DATABASE_URL="file:${DB_FILE}"
fi

# Pick schema + migrations dir from the URL scheme. Anything starting
# `postgres://` or `postgresql://` is treated as Postgres; anything else
# (defaulted to `file:` above) is treated as SQLite.
case "${DATABASE_URL}" in
  postgres://*|postgresql://*)
    PROVIDER="postgresql"
    SCHEMA="prisma/postgres/schema.prisma"
    MIGRATIONS_DIR="prisma/postgres/migrations"
    ;;
  *)
    PROVIDER="sqlite"
    SCHEMA="prisma/schema.prisma"
    MIGRATIONS_DIR="prisma/migrations"
    mkdir -p "${DATA_DIR}"
    ;;
esac

cd /app/server

echo "[entrypoint] provider=${PROVIDER} schema=${SCHEMA} migrations=${MIGRATIONS_DIR}"

# The image is built with `prisma generate` against the SQLite schema. When
# DATABASE_URL points at Postgres we need to regenerate the client so the
# embedded datamodel matches the live datasource. (No-op for sqlite.)
if [ "${PROVIDER}" = "postgresql" ]; then
  echo "[entrypoint] regenerating Prisma client for postgresql"
  node node_modules/prisma/build/index.js generate --schema="${SCHEMA}" --no-hints >/dev/null
fi

echo "[entrypoint] applying prisma migrations against ${DATABASE_URL}"
node node_modules/prisma/build/index.js migrate deploy --schema="${SCHEMA}"

# Seed only when the User table is empty. The seed script is idempotent on
# username conflicts (upsert) but skipping the noisy log when there's nothing
# to do keeps boot output clean. Errors fall through (we treat empty count
# as 0 — `count` may fail before the table exists which is itself a signal
# the seed should run).
USER_COUNT=$(node -e "
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.user.count().then(n => { console.log(n); process.exit(0); }).catch(() => { console.log(0); process.exit(0); });
" 2>/dev/null || echo 0)

if [ "${USER_COUNT}" = "0" ]; then
  echo "[entrypoint] empty database — running seed"
  # The prisma seed config invokes `tsx prisma/seed.ts`. Make sure tsx
  # (a workspace devDep) is on PATH — it lives under each workspace's
  # `node_modules/.bin/`.
  PATH="/app/server/node_modules/.bin:/app/node_modules/.bin:${PATH}" \
    node node_modules/prisma/build/index.js db seed --schema="${SCHEMA}" || {
    echo "[entrypoint] seed failed (non-fatal — continuing)" >&2
  }
else
  echo "[entrypoint] database already seeded (${USER_COUNT} users) — skipping"
fi

cd /app

# The entrypoint already ran `prisma migrate deploy` above against the
# correct schema; tell the in-process migration-guard not to re-run it.
# (The guard's default code path doesn't pass --schema and would re-resolve
# to the SQLite schema, breaking the postgres path.)
export METIS_SKIP_MIGRATE=1

echo "[entrypoint] launching: $*"
exec "$@"
