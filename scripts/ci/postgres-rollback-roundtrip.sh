#!/usr/bin/env bash
# Issue #2566 — prove a Postgres migration's committed rollback on a real
# database: with the chain deployed, seed rows, apply the rollback, assert the
# column is gone and the rows survive, re-deploy, assert the column is back with
# the default it had before (information_schema.columns.column_default) and the
# rows still survive.
#
#   scripts/ci/postgres-rollback-roundtrip.sh <migration> <table> <column> <seed.sql> <survivor query>
#
# <survivor query> returns one row per seeded row that must survive both
# directions (it must not name <column>). Runs in the postgres-migrate-deploy
# job, after `prisma migrate deploy`, against the container start-postgres.sh
# started; DATABASE_URL comes from that step.
set -euo pipefail

MIGRATION="$1"
TABLE="$2"
COLUMN="$3"
SEED_SQL="$4"
SURVIVORS="$5"
NAME="metis-ci-postgres-${GITHUB_JOB}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
ROLLBACK="server/prisma/postgres/rollbacks/${MIGRATION}.sql"

psql_() { docker exec -i "${NAME}" psql -U metis -d metis -v ON_ERROR_STOP=1 -tA "$@"; }
column_count() {
  psql_ -c "SELECT count(*) FROM information_schema.columns WHERE table_name = '${TABLE}' AND column_name = '${COLUMN}'"
}
column_default() {
  psql_ -c "SELECT coalesce(column_default, '<none>') FROM information_schema.columns WHERE table_name = '${TABLE}' AND column_name = '${COLUMN}'"
}
expect() {
  if [ "$2" != "$3" ]; then
    echo "::error::$1: expected '$3', got '$2'"
    exit 1
  fi
  echo "ok: $1 = $3"
}

expect "column before the rollback" "$(column_count)" "1"
default_before="$(column_default)"
psql_ -1 < "${SEED_SQL}"
before="$(psql_ -c "${SURVIVORS}")"
[ -n "${before}" ] || { echo "::error::the seed left no survivor rows"; exit 1; }

psql_ -1 < "${ROLLBACK}"
expect "column after the rollback" "$(column_count)" "0"
expect "rows after the rollback" "$(psql_ -c "${SURVIVORS}")" "${before}"
expect "migration forgotten" \
  "$(psql_ -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '${MIGRATION}'")" "0"

(cd server && pnpm prisma migrate deploy)
expect "column after re-deploy" "$(column_count)" "1"
expect "rows after re-deploy" "$(psql_ -c "${SURVIVORS}")" "${before}"
expect "column default after re-deploy" "$(column_default)" "${default_before}"
