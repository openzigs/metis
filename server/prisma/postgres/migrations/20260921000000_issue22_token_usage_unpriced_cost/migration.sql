-- Issue #22 — `token_usages.costCents` becomes NULLABLE (Postgres mirror). See
-- the SQLite migration of the same name for the full rationale: NULL means the
-- model was UNPRICED when the row was written — unknown spend, never zero spend.
--
-- `DROP NOT NULL` and `DROP DEFAULT` are idempotent (no-ops when already
-- applied), so replaying the chain over the cumulative init baseline — which
-- now declares the column nullable with no default — never collides (#556).
--
-- Rollback:
--   UPDATE "token_usages" SET "costCents" = 0 WHERE "costCents" IS NULL;
--   ALTER TABLE "token_usages" ALTER COLUMN "costCents" SET DEFAULT 0,
--     ALTER COLUMN "costCents" SET NOT NULL;
ALTER TABLE "token_usages" ALTER COLUMN "costCents" DROP NOT NULL,
ALTER COLUMN "costCents" DROP DEFAULT;
