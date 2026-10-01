/**
 * #637 — a foreign-owner rotate attempt no longer loads and hashes every
 * binding of the secret. The whole-set summary (digest, total, counts, capped
 * listing) is cached against the vault binding epoch, which database triggers
 * bump on every write that can change a secret's bindings.
 *
 * Proven against a REAL SQLite database built from the migration chain:
 *
 *   - the triggers: every insert and delete of the six binding tables bumps the
 *     epoch, an update bumps it exactly when it sets a column in
 *     `BINDING_SUMMARY_COLUMNS`, and the Postgres chain declares the same lists;
 *   - the benchmark: through the REAL vault router, repeated refusals and
 *     confirms of a secret with five times the list cap load NO binding rows
 *     and a fixed handful of queries, while a binding write still changes the
 *     digest on the very next attempt (the #611 guarantee), and every column the
 *     summary queries read is one the triggers watch;
 *   - the fallback: without the epoch row (a `prisma db push` database) every
 *     attempt computes the summary in full, as before.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

const { vaultRouter } = await import("../src/routes/vault.js");
const { BINDING_SUMMARY_COLUMNS, MAX_CONFIRMED_BINDINGS, __resetForeignOwnerSummaries } =
  await import("../src/lib/vault/rotate-foreign-owner.js");
const { JSON_LIMIT_BYTES } = await import("../src/lib/config/json-limit.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TABLES = Object.keys(BINDING_SUMMARY_COLUMNS) as Array<keyof typeof BINDING_SUMMARY_COLUMNS>;
/** The Prisma model behind each binding table, as the summary queries name it. */
const MODEL_TABLE: Record<string, keyof typeof BINDING_SUMMARY_COLUMNS> = {
  DatabaseConnection: "database_connections",
  RepoConnection: "repo_connections",
  ImportSource: "import_sources",
  MCPServer: "mcp_servers",
  JiraConnection: "jira_connections",
  TestManagementConnection: "test_management_connections",
};

/**
 * The column list of the LATEST definition of each epoch trigger in a
 * migration chain, keyed by table: a later migration that re-creates a trigger
 * (after an SQLite table redefinition, say) supersedes the first one.
 */
function triggerColumns(migrationsDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const dirs = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(path.join(migrationsDir, dir, "migration.sql"), "utf8");
    for (const m of sql.matchAll(/UPDATE OF ([^\n]+?) ON "([a-z_]+)"/g)) {
      out.set(
        m[2]!,
        m[1]!.split(",").map((c) => c.trim().replace(/^"|"$/g, "")),
      );
    }
  }
  return out;
}

describe("#637 — both migration chains watch exactly BINDING_SUMMARY_COLUMNS", () => {
  for (const [chain, dir] of [
    ["sqlite", path.join(SERVER_ROOT, "prisma", "migrations")],
    ["postgres", path.join(SERVER_ROOT, "prisma", "postgres", "migrations")],
  ] as const) {
    it(`${chain}: each table's update trigger lists the summary's columns, no more and no fewer`, () => {
      const declared = triggerColumns(dir);
      for (const table of TABLES) {
        expect([...(declared.get(table) ?? [])].sort(), `${chain} ${table}`).toEqual(
          [...BINDING_SUMMARY_COLUMNS[table]].sort(),
        );
      }
    });
  }
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#637 — the vault binding epoch and the bounded foreign-owner rotate",
  () => {
    let sqlite: MigratedSqlite;
    let raw: Database.Database;
    let base: PrismaClient;
    let adminToken = "";
    let n = 0;

    /** Every Prisma operation the code under test runs, and the rows each read returned. */
    const ops: Array<{ model: string; operation: string; args: unknown; rows: number }> = [];
    const bindingOps = () => ops.filter((o) => o.model in MODEL_TABLE);
    const bindingRows = () => bindingOps().reduce((sum, o) => sum + o.rows, 0);
    const epoch = () =>
      Number(
        (
          raw.prepare(`SELECT "epoch" FROM "vault_binding_epochs" WHERE "id" = 1`).get() as
            { epoch: number | bigint } | undefined
        )?.epoch ?? -1,
      );

    const rotate = (id: string, body: Record<string, unknown>) => {
      const a = express();
      a.use(express.json({ limit: JSON_LIMIT_BYTES }));
      a.use("/api/vault", vaultRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return request(a)
        .post(`/api/vault/${id}/rotate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body);
    };
    const newSecret = async () => {
      n += 1;
      return (
        await getVaultService().create(`s637-${n}`, "owner-token-637", "global", {
          createdById: "u-owner",
        })
      ).id;
    };
    const bindMany = (secretId: string, count: number, prefix: string) =>
      base.databaseConnection.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          id: `${prefix}-${i}`,
          projectId: "proj-637",
          label: `${prefix}-${i}`,
          driver: "postgres",
          host: `h${i}.owner.example`,
          secretId,
        })),
      });
    type View = {
      bindings: unknown[];
      bindingsTotal: number;
      bindingsDigest: string;
      bindingCounts: { byType: Array<{ type: string; count: number }> };
    };
    const refusal = async (id: string) => {
      const res = await rotate(id, { value: "admin-token-637" });
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_FOREIGN_OWNER");
      return res.body.error.details as View;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("637-vault-binding-epoch");
      raw = new Database(sqlite.dbFile);
      // Raw rows below carry placeholder references; the triggers, not the keys, are under test.
      raw.pragma("foreign_keys = OFF");
      base = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = base.$extends({
        query: {
          $allModels: {
            async $allOperations({ model, operation, args, query }) {
              const result = await query(args);
              ops.push({
                model,
                operation,
                args,
                rows: Array.isArray(result) ? result.length : result ? 1 : 0,
              });
              return result;
            },
          },
        },
      });
      __resetVaultSingleton();
      for (const id of ["u-admin", "u-owner"]) {
        await base.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await base.project.create({
        data: { id: "proj-637", name: "proj-637", slug: "proj-637", createdById: "u-owner" },
      });
      adminToken = issueTokens({
        userId: "u-admin",
        username: "u-admin",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      __resetForeignOwnerSummaries();
      ops.length = 0;
    });

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      raw?.close();
      await base?.$disconnect();
      sqlite?.cleanup();
    });

    // ── The triggers ──────────────────────────────────────────────────────

    /** A placeholder for a NOT NULL column with no default, by declared type. */
    const placeholder = (type: string): unknown =>
      /INT|BOOL/i.test(type) ? 0 : /DATE|TIME/i.test(type) ? Date.now() : "x";
    const insertRow = (table: string, id: string) => {
      const cols = (
        raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
          name: string;
          type: string;
          notnull: number;
          dflt_value: unknown;
        }>
      ).filter((c) => c.name === "id" || (c.notnull === 1 && c.dflt_value === null));
      const values = cols.map((c) => (c.name === "id" ? id : placeholder(c.type)));
      raw
        .prepare(
          `INSERT INTO "${table}" (${cols.map((c) => `"${c.name}"`).join(", ")}) VALUES (${cols
            .map(() => "?")
            .join(", ")})`,
        )
        .run(...values);
    };
    const columnsOf = (table: string) =>
      (raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      );

    it("the migration seeds the single epoch row", () => {
      expect(epoch()).toBeGreaterThanOrEqual(0);
      expect(raw.prepare(`SELECT COUNT(*) AS c FROM "vault_binding_epochs"`).get()).toEqual({
        c: 1,
      });
    });

    for (const table of TABLES) {
      it(`${table}: insert, delete and an update of a summary column bump the epoch; nothing else does`, () => {
        // Raw statements on a second connection: no Prisma, no foreign keys —
        // the triggers alone must see every write.
        const id = `${table}-epoch-row`;
        let before = epoch();
        insertRow(table, id);
        expect(epoch(), "insert").toBe(before + 1);

        const watched = new Set<string>(BINDING_SUMMARY_COLUMNS[table]);
        for (const col of columnsOf(table)) {
          if (col === "id") continue;
          before = epoch();
          raw.prepare(`UPDATE "${table}" SET "${col}" = "${col}" WHERE "id" = ?`).run(id);
          expect(epoch(), `update of ${table}.${col}`).toBe(watched.has(col) ? before + 1 : before);
        }

        before = epoch();
        raw.prepare(`DELETE FROM "${table}" WHERE "id" = ?`).run(id);
        expect(epoch(), "delete").toBe(before + 1);
      });
    }

    it("a project delete cascades to its connectors and bumps the epoch", async () => {
      await base.project.create({
        data: { id: "proj-637-gone", name: "gone", slug: "proj-637-gone", createdById: "u-owner" },
      });
      await base.databaseConnection.create({
        data: { id: "gone-db", projectId: "proj-637-gone", label: "g", driver: "postgres" },
      });
      const before = epoch();
      await base.project.delete({ where: { id: "proj-637-gone" } });
      expect(await base.databaseConnection.count({ where: { id: "gone-db" } })).toBe(0);
      expect(epoch()).toBeGreaterThan(before);
    });

    // ── The benchmark ─────────────────────────────────────────────────────

    const HUGE = 5 * MAX_CONFIRMED_BINDINGS;

    it("repeated attempts on an unchanged 5x-cap set load no binding rows; a binding write recomputes once", async () => {
      const id = await newSecret();
      await bindMany(id, HUGE, "huge");

      // The first attempt computes the summary: it reads the whole set once.
      ops.length = 0;
      const first = await refusal(id);
      expect(first.bindingsTotal).toBe(HUGE);
      expect(bindingRows()).toBe(HUGE);

      // Every later attempt reuses it: no binding row, and a fixed query count
      // (the secret's owner, the owner's user row, the epoch).
      for (let i = 0; i < 5; i += 1) {
        ops.length = 0;
        const again = await refusal(id);
        expect(again.bindingsDigest).toBe(first.bindingsDigest);
        expect(again.bindingsTotal).toBe(HUGE);
        expect(again.bindings).toHaveLength(MAX_CONFIRMED_BINDINGS);
        expect(bindingOps()).toHaveLength(0);
        expect(ops.length).toBeLessThanOrEqual(3);
      }

      // A stale digest is refused, still without loading the set.
      ops.length = 0;
      const stale = await rotate(id, {
        value: "admin-token-637",
        confirmForeignOwner: true,
        confirmedBindingsDigest: "ab".repeat(32),
      });
      expect(stale.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      expect(bindingRows()).toBe(0);

      // A health-style update routes nothing: still cached.
      await base.databaseConnection.update({
        where: { id: "huge-3" },
        data: { status: "connected", lastTestedAt: new Date() },
      });
      ops.length = 0;
      expect((await refusal(id)).bindingsDigest).toBe(first.bindingsDigest);
      expect(bindingRows()).toBe(0);

      // #611 — a re-point (written straight to the table, no binding check)
      // changes the digest on the very next attempt, which recomputes once.
      await base.databaseConnection.update({
        where: { id: "huge-4000" },
        data: { host: "evil.owner.example" },
      });
      ops.length = 0;
      const confirmOld = await rotate(id, {
        value: "admin-token-637",
        confirmForeignOwner: true,
        confirmedBindingsDigest: first.bindingsDigest,
      });
      expect(confirmOld.status).toBe(409);
      expect(confirmOld.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      const fresh = confirmOld.body.error.details as View;
      expect(fresh.bindingsDigest).not.toBe(first.bindingsDigest);
      expect(bindingRows()).toBe(HUGE);

      // The fresh digest confirms, from the cache: no binding row read.
      ops.length = 0;
      const ok = await rotate(id, {
        value: "admin-token-637",
        confirmForeignOwner: true,
        confirmedBindingsDigest: fresh.bindingsDigest,
      });
      expect(ok.status, JSON.stringify(ok.body).slice(0, 300)).toBe(200);
      expect(bindingRows()).toBe(0);
      expect((await getVaultService().read(id)).plaintext).toBe("admin-token-637");
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      const [row] = await base.auditLog.findMany({
        where: { action: "vault.rotate", targetType: "secret", targetId: id },
      });
      const meta = JSON.parse(row!.metadata ?? "{}") as Record<string, unknown>;
      expect(meta.confirmedBindingsDigest).toBe(fresh.bindingsDigest);
      expect(meta.confirmedBindingsTotal).toBe(HUGE);
    });

    it("every column the summary queries select or filter on is one the triggers watch", async () => {
      const id = await newSecret();
      ops.length = 0;
      await refusal(id);
      const reads = bindingOps();
      expect(new Set(reads.map((o) => o.model))).toEqual(new Set(Object.keys(MODEL_TABLE)));
      const LOGICAL = new Set(["OR", "AND", "NOT"]);
      const whereColumns = (where: unknown): string[] =>
        Array.isArray(where)
          ? where.flatMap(whereColumns)
          : where && typeof where === "object"
            ? Object.entries(where).flatMap(([k, v]) => (LOGICAL.has(k) ? whereColumns(v) : [k]))
            : [];
      for (const op of reads) {
        const args = op.args as { select?: Record<string, unknown>; where?: unknown };
        const watched: readonly string[] = BINDING_SUMMARY_COLUMNS[MODEL_TABLE[op.model]!];
        for (const col of [...Object.keys(args.select ?? {}), ...whereColumns(args.where)]) {
          expect(watched, `${op.model}.${col}`).toContain(col);
        }
      }
    });

    it("an MCP server that binds the secret by label after a cached refusal is listed on the next one", async () => {
      const id = await newSecret();
      await bindMany(id, 2, `mcp-pre-${n}`);
      const first = await refusal(id);
      expect(first.bindingsTotal).toBe(2);
      await base.mCPServer.create({
        data: {
          label: `mcp-637-${n}`,
          transport: "stdio",
          command: "npx srv",
          envJson: JSON.stringify({ TOKEN: `\${vault:s637-${n}}` }),
        },
      });
      const next = await refusal(id);
      expect(next.bindingsTotal).toBe(3);
      expect(next.bindingCounts.byType).toContainEqual({ type: "mcp_server", count: 1 });
      expect(next.bindingsDigest).not.toBe(first.bindingsDigest);
    });

    it("without the epoch row (a db-push database) nothing is cached and every attempt recomputes", async () => {
      const id = await newSecret();
      await bindMany(id, 3, `nopush-${n}`);
      const saved = epoch();
      raw.prepare(`DELETE FROM "vault_binding_epochs"`).run();
      try {
        ops.length = 0;
        const a = await refusal(id);
        // The three connectors, plus any MCP candidate rows an earlier test left.
        const loadsA = bindingRows();
        expect(loadsA).toBeGreaterThanOrEqual(3);
        ops.length = 0;
        const b = await refusal(id);
        expect(bindingRows()).toBe(loadsA);
        expect(b.bindingsDigest).toBe(a.bindingsDigest);
      } finally {
        raw.prepare(`INSERT INTO "vault_binding_epochs" ("id", "epoch") VALUES (1, ?)`).run(saved);
      }
    });
  },
);
