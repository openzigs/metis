-- Issue #637 — bound the work of a foreign-owner vault rotation.
--
-- `describeForeignOwner` loaded and hashed every binding of the secret on every
-- rotate attempt, so an owner who inflated the bindings made each attempt (and
-- each refusal) O(n). The summary it computes (set digest, total, per-type and
-- per-host counts, the capped listing) is now cached per secret against this
-- epoch, which these triggers bump on every write that can change ANY secret's
-- bindings, inside that write's own transaction. The rotation
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
-- NOTE for later migrations: SQLite's table redefinition (the
-- `INSERT INTO "new_<table>"` / `DROP TABLE` / `RENAME` dance Prisma writes when
-- it cannot ALTER a column) DROPS that table's triggers. A migration that
-- redefines one of these six tables must re-create its three triggers below;
-- `vault-binding-epoch-637.sqlite.test.ts` fails if one is missing.
--
-- Rollback (documentation): DROP TRIGGER each "vault_binding_epoch_*" trigger,
-- then `DROP TABLE "vault_binding_epochs";`. Lossless: the epoch is a cache key,
-- and without it every summary is computed in full.

-- CreateTable
CREATE TABLE "vault_binding_epochs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "epoch" BIGINT NOT NULL DEFAULT 0
);

INSERT INTO "vault_binding_epochs" ("id", "epoch") VALUES (1, 0);

CREATE TRIGGER "vault_binding_epoch_database_connections_insert" AFTER INSERT ON "database_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_database_connections_delete" AFTER DELETE ON "database_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_database_connections_update" AFTER UPDATE OF "id", "projectId", "label", "secretId", "deletedAt", "driver", "host", "port", "databaseName", "options" ON "database_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;

CREATE TRIGGER "vault_binding_epoch_repo_connections_insert" AFTER INSERT ON "repo_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_repo_connections_delete" AFTER DELETE ON "repo_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_repo_connections_update" AFTER UPDATE OF "id", "projectId", "label", "secretId", "deletedAt", "provider", "apiBaseUrl" ON "repo_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;

CREATE TRIGGER "vault_binding_epoch_import_sources_insert" AFTER INSERT ON "import_sources"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_import_sources_delete" AFTER DELETE ON "import_sources"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_import_sources_update" AFTER UPDATE OF "id", "projectId", "label", "secretId", "deletedAt", "source", "baseUrl", "jiraConnectionId", "filter" ON "import_sources"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;

CREATE TRIGGER "vault_binding_epoch_mcp_servers_insert" AFTER INSERT ON "mcp_servers"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_mcp_servers_delete" AFTER DELETE ON "mcp_servers"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_mcp_servers_update" AFTER UPDATE OF "id", "projectId", "label", "deletedAt", "envSecretId", "envJson", "headers", "transport", "runtime", "command", "args", "url", "egressAllowlist" ON "mcp_servers"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;

CREATE TRIGGER "vault_binding_epoch_jira_connections_insert" AFTER INSERT ON "jira_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_jira_connections_delete" AFTER DELETE ON "jira_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_jira_connections_update" AFTER UPDATE OF "id", "projectId", "label", "secretId", "tlsCaSecretId", "deletedAt", "baseUrl", "proxyUrl", "tlsRejectUnauthorized" ON "jira_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;

CREATE TRIGGER "vault_binding_epoch_test_management_connections_insert" AFTER INSERT ON "test_management_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_test_management_connections_delete" AFTER DELETE ON "test_management_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
CREATE TRIGGER "vault_binding_epoch_test_management_connections_update" AFTER UPDATE OF "id", "projectId", "label", "deletedAt", "authConfigJson", "tlsConfigJson", "kind", "baseUrl", "proxyConfigJson" ON "test_management_connections"
BEGIN UPDATE "vault_binding_epochs" SET "epoch" = "epoch" + 1 WHERE "id" = 1; END;
