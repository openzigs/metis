-- Issue #637 — bound the work of a foreign-owner vault rotation (Postgres
-- mirror). See the SQLite migration of the same name for the full rationale.
-- The triggers are statement-level: one bump per statement, whatever its row
-- count, inside the statement's transaction. The rotation
-- reads it BEFORE it loads the bindings, so a write that commits after that read
-- moves the epoch past the cached entry and the next attempt recomputes.
--
-- Every insert and delete bumps it, and every update of a column the summary
-- reads: the columns that select a binding (the secret reference, `deletedAt`)
-- and the ones it lists or digests (label, project, every routing field). The
-- list per table must equal `BINDING_SUMMARY_COLUMNS` in
-- `lib/vault/rotate-foreign-owner.ts`; `rotate-foreign-owner-epoch.test.ts`
-- fails when they drift. Health and status columns (an MCP server's
-- `lastHealthCheckAt`, a connector's `status`) are left out on purpose: they
-- change every minute and route nothing. Foreign-key cascades and SET NULL
-- actions fire these triggers too, so a project delete or a secret delete
-- bumps it as well.
--
-- The single row is inserted here and nowhere else. A database built by
-- `prisma db push` has the table (it is in schema.prisma) but neither the row
-- nor the triggers, and the server then caches nothing and computes every
-- summary in full, as before #637.
--
-- Idempotent like the rest of the chain (issue #556): IF NOT EXISTS, ON
-- CONFLICT DO NOTHING, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS.
--
-- Rollback (documentation): DROP TRIGGER each "vault_binding_epoch_*" trigger,
-- `DROP FUNCTION "vault_binding_epoch_bump"();`, then
-- `DROP TABLE "vault_binding_epochs";`. Lossless: the epoch is a cache key.

-- CreateTable
CREATE TABLE IF NOT EXISTS "vault_binding_epochs" (
    "id" INTEGER NOT NULL,
    "epoch" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "vault_binding_epochs_pkey" PRIMARY KEY ("id")
);

INSERT INTO "vault_binding_epochs" ("id", "epoch") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING;

CREATE OR REPLACE FUNCTION "vault_binding_epoch_bump"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "vault_binding_epoch_database_connections" ON "database_connections";
CREATE TRIGGER "vault_binding_epoch_database_connections"
AFTER INSERT OR DELETE OR UPDATE OF "id", "projectId", "label", "secretId", "deletedAt", "driver", "host", "port", "databaseName", "options" ON "database_connections"
FOR EACH STATEMENT EXECUTE FUNCTION "vault_binding_epoch_bump"();

DROP TRIGGER IF EXISTS "vault_binding_epoch_repo_connections" ON "repo_connections";
CREATE TRIGGER "vault_binding_epoch_repo_connections"
AFTER INSERT OR DELETE OR UPDATE OF "id", "projectId", "label", "secretId", "deletedAt", "provider", "apiBaseUrl" ON "repo_connections"
FOR EACH STATEMENT EXECUTE FUNCTION "vault_binding_epoch_bump"();

DROP TRIGGER IF EXISTS "vault_binding_epoch_import_sources" ON "import_sources";
CREATE TRIGGER "vault_binding_epoch_import_sources"
AFTER INSERT OR DELETE OR UPDATE OF "id", "projectId", "label", "secretId", "deletedAt", "source", "baseUrl", "jiraConnectionId", "filter" ON "import_sources"
FOR EACH STATEMENT EXECUTE FUNCTION "vault_binding_epoch_bump"();

DROP TRIGGER IF EXISTS "vault_binding_epoch_mcp_servers" ON "mcp_servers";
CREATE TRIGGER "vault_binding_epoch_mcp_servers"
AFTER INSERT OR DELETE OR UPDATE OF "id", "projectId", "label", "deletedAt", "envSecretId", "envJson", "headers", "transport", "runtime", "command", "args", "url", "egressAllowlist" ON "mcp_servers"
FOR EACH STATEMENT EXECUTE FUNCTION "vault_binding_epoch_bump"();

DROP TRIGGER IF EXISTS "vault_binding_epoch_jira_connections" ON "jira_connections";
CREATE TRIGGER "vault_binding_epoch_jira_connections"
AFTER INSERT OR DELETE OR UPDATE OF "id", "projectId", "label", "secretId", "tlsCaSecretId", "deletedAt", "baseUrl", "proxyUrl", "tlsRejectUnauthorized" ON "jira_connections"
FOR EACH STATEMENT EXECUTE FUNCTION "vault_binding_epoch_bump"();

DROP TRIGGER IF EXISTS "vault_binding_epoch_test_management_connections" ON "test_management_connections";
CREATE TRIGGER "vault_binding_epoch_test_management_connections"
AFTER INSERT OR DELETE OR UPDATE OF "id", "projectId", "label", "deletedAt", "authConfigJson", "tlsConfigJson", "kind", "baseUrl", "proxyConfigJson" ON "test_management_connections"
FOR EACH STATEMENT EXECUTE FUNCTION "vault_binding_epoch_bump"();
