#!/usr/bin/env bash
# One-command dev-DB switch (hybrid: sqlite default, Postgres on demand).
# Usage:  scripts/dev-db.sh sqlite     # back to the file-based dev store (+ tests)
#         scripts/dev-db.sh postgres   # switch dev to the local Postgres container
#
# NOTE: the generated Prisma client is a single global artifact, so the client
# is regenerated for the chosen provider.
#
# Since #876 you do NOT have to switch back before running tests: `pnpm test`
# detects the generated client's provider and picks a compatible datasource, so
# the unit suite is green on either target. (The unit suite stubs Prisma and
# executes no SQL, so it needs no database either way — real-Postgres parity is
# `pnpm test:integration` and the postgres-adapter CI job.) The one exception is
# server/src/lib/portability/logical-roundtrip.test.ts, which builds real SQLite
# files and therefore skips on the postgres target.
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:-}"
PG_URL="postgresql://metis:metis@localhost:5432/metis"
case "$target" in
  postgres|pg)
    docker start metis-dev-pg >/dev/null 2>&1 || \
      docker run -d --name metis-dev-pg -v metis-pg-data:/var/lib/postgresql/data \
        -e POSTGRES_USER=metis -e POSTGRES_PASSWORD=metis -e POSTGRES_DB=metis \
        -p 5432:5432 postgres:16-alpine >/dev/null
    perl -0pi -e "s{^DATABASE_URL=.*\$}{DATABASE_URL=$PG_URL}m" .env
    ( cd server && DATABASE_URL="$PG_URL" npx prisma generate >/dev/null \
        && DATABASE_URL="$PG_URL" npx prisma migrate deploy \
        && DATABASE_URL="$PG_URL" npx tsx prisma/seed.ts || true )
    echo "dev DB -> Postgres. Restart the dev server (pnpm dev). \`pnpm test\` still works."
    ;;
  sqlite|file)
    perl -0pi -e 's{^DATABASE_URL=.*$}{DATABASE_URL=file:./dev.db}m' .env
    ( cd server && DATABASE_URL="file:./dev.db" npx prisma generate >/dev/null )
    echo "dev DB -> SQLite (server/dev.db). Restart the dev server (pnpm dev)."
    ;;
  *) echo "usage: scripts/dev-db.sh [sqlite|postgres]" >&2; exit 2 ;;
esac
