/**
 * #504 — the follow-ups #480 (PR #499) deferred.
 *
 *   1. MCP servers and live publish batches saved before #480 carry no
 *      binding; `backfillSecretBindings` binds each reference with the #344
 *      matching rule, and flags — never guesses — one that is ambiguous or
 *      reaches nothing, leaving it unable to resolve by label.
 *   2. Jira connections read their stored secret id and nothing else: a
 *      secret created with a LABEL equal to that id, after the bound one is
 *      deleted, is never picked up.
 *
 * Real vault, real audit, real SQLite built from the migration chain. The
 * Jira client factory is the only stub, and it records the token it is handed.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown, sent: [] as string[] }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/connectors/network-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertConnectorHostAllowed: async () => undefined,
}));
// #504 — the publish path up to the GitHub client is real; the client factory
// records the token it would authenticate with, and resolving the target does
// no DNS.
vi.mock("../src/lib/publishing/host-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePublishTarget: async (t: { owner: string; repo: string }) => ({
    owner: t.owner,
    repo: t.repo,
    baseUrl: "https://api.github.com",
    pinnedAddress: "140.82.112.6",
    pinnedFamily: 4,
  }),
}));
vi.mock("../src/lib/publishing/octokit-factory.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  acquirePublishOctokit: async (o: { token: string }) => {
    state.sent.push(o.token);
    throw new Error("octokit stub: token captured");
  },
}));
vi.mock("../src/lib/connectors/jira/jira-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createJiraClient: (cfg: { apiToken: string }) => {
    state.sent.push(cfg.apiToken);
    return {};
  },
}));

const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { backfillSecretBindings, BACKFILL_FLAGGED_ACTION } =
  await import("../src/lib/vault/secret-binding-backfill.js");
const { parseSecretBindings } = await import("../src/lib/vault/bound-secret.js");
const { expandVaultRefs } = await import("../src/lib/vault/env-manager.js");
const { batchTokenSource, executeBatch, archiveBatch } =
  await import("../src/lib/publishing/publishing-service.js");
const { buildJiraClientForConnection } = await import("../src/lib/connectors/jira/jira-service.js");

const PROJ = "proj-504-backfill";
const ADMIN_VALUE = "admin-value-504";
const FOREIGN_VALUE = "foreign-value-504";
const ref = (body: string) => `\${vault:${body}}`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#504 — pre-#480 references are bound or flagged; stored ids never resolve by label",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let seq = 0;
    const next = () => (seq += 1);

    const secret = async (label: string, value: string, scope: "global" | "project" = "global") =>
      (await getVaultService().create(label, value, scope, { createdById: "u-coord" })).id;
    /** A secret someone other than the resource's owner created. */
    const foreignSecret = async (label: string, value = FOREIGN_VALUE) =>
      (await getVaultService().create(label, value, "global", { createdById: "u-other" })).id;
    /**
     * Run `between` after the backfill has read the rows and before it writes
     * row `id`: the prisma client the backfill sees is wrapped so that model's
     * `updateMany` for that row first lets a concurrent writer in.
     */
    const racing = async <T>(
      model: "mCPServer" | "publishBatch",
      id: string,
      between: () => Promise<unknown>,
      run: () => Promise<T>,
    ): Promise<T> => {
      let raced = false;
      const delegate = db[model] as unknown as Record<string, unknown>;
      const wrapped = new Proxy(delegate, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (prop !== "updateMany" || typeof value !== "function") return value;
          return async (args: { where?: { id?: string } }) => {
            if (!raced && args.where?.id === id) {
              raced = true;
              await between();
            }
            return (value as (a: unknown) => Promise<unknown>).call(target, args);
          };
        },
      });
      state.db = new Proxy(db, {
        get: (target, prop) => (prop === model ? wrapped : Reflect.get(target, prop)),
      });
      try {
        const out = await run();
        expect(raced).toBe(true);
        return out;
      } finally {
        state.db = db;
      }
    };
    /** Delete the bound secret, then create a secret whose LABEL is its id. */
    const squatOnId = async (id: string) => {
      await getVaultService().delete(id);
      await getVaultService().create(id, ADMIN_VALUE, "global", { createdById: "u-admin" });
    };

    /** An MCP server row as saved before #480: `secretBindings` NULL. */
    const legacyMcp = async (env: Record<string, string>, headers?: Record<string, string>) =>
      (
        await db.mCPServer.create({
          data: {
            label: `mcp-504-${next()}`,
            transport: headers ? "http" : "stdio",
            command: headers ? null : "node",
            url: headers ? "https://mcp.example.test" : null,
            headers: headers ? JSON.stringify(headers) : null,
            envJson: JSON.stringify(env),
            createdById: "u-coord",
          },
        })
      ).id;
    const bindingsOf = async (id: string) =>
      parseSecretBindings((await db.mCPServer.findUniqueOrThrow({ where: { id } })).secretBindings);

    /** A publish batch as created before #480: `metadata` with no `secretId`. */
    const legacyBatch = async (
      metadata: Record<string, unknown>,
      dryRun = false,
      targetBaseUrl: string | null = null,
    ) =>
      (
        await db.publishBatch.create({
          data: {
            projectId: PROJ,
            targetOwner: "o",
            targetRepo: "r",
            targetBaseUrl,
            dryRun,
            startedById: "u-coord",
            metadata: JSON.stringify(metadata),
          },
        })
      ).id;
    const metaOf = async (id: string) =>
      JSON.parse((await db.publishBatch.findUniqueOrThrow({ where: { id } })).metadata!) as Record<
        string,
        unknown
      >;

    const flagsFor = async (id: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      const rows = await db.auditLog.findMany({
        where: { action: BACKFILL_FLAGGED_ACTION, targetId: id },
      });
      return rows.map((r) => JSON.parse(r.metadata ?? "{}").flagged);
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("504-secret-binding-backfill");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();
      for (const id of ["u-admin", "u-coord", "u-other", "u-revealer"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: "u-admin" },
      });
      // `u-revealer` holds `vault.reveal` (admin); `u-coord` and `u-other` hold no role.
      const adminRole = await db.role.upsert({
        where: { key: "admin" },
        update: {},
        create: { key: "admin", name: "admin", isSystem: true },
      });
      await db.userRole.create({
        data: { userId: "u-revealer", roleId: adminRole.id, source: "local" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      state.sent.length = 0;
    });

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    /**
     * Run `run` with the secret lookup `bindSecretRefs` makes throwing an
     * unexpected (non-flag) error whenever it is asked about `poison`.
     */
    const failingLookupFor = async <T>(poison: string, run: () => Promise<T>): Promise<T> => {
      const delegate = db.secret as unknown as Record<string, unknown>;
      const wrapped = new Proxy(delegate, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (prop !== "findMany" || typeof value !== "function") return value;
          return async (args: unknown) => {
            if (JSON.stringify(args).includes(poison)) throw new Error("database is on fire");
            return (value as (a: unknown) => Promise<unknown>).call(target, args);
          };
        },
      });
      state.db = new Proxy(db, {
        get: (target, prop) => (prop === "secret" ? wrapped : Reflect.get(target, prop)),
      });
      try {
        return await run();
      } finally {
        state.db = db;
      }
    };

    describe("one row's unexpected error does not stop the rest (PR #518 panel)", () => {
      it("MCP servers: the row after a failing one is still bound", async () => {
        const poison = `mcp-poison-504-${next()}`;
        const good = `mcp-after-poison-504-${next()}`;
        const goodId = await secret(good, "good-value");
        const failing = await legacyMcp({ TOKEN: ref(poison) });
        const later = await legacyMcp({ TOKEN: ref(good) });

        const report = await failingLookupFor(poison, () => backfillSecretBindings());

        expect(await bindingsOf(later)).toEqual({ [good]: goodId });
        expect(report.mcpServersBound).toBeGreaterThanOrEqual(1);
        // The failing row stays unbound, for the next boot to retry.
        expect(
          (await db.mCPServer.findUniqueOrThrow({ where: { id: failing } })).secretBindings,
        ).toBeNull();
        expect(await flagsFor(failing)).toEqual([]);
      });

      it("publish batches: the batch after a failing one is still bound", async () => {
        const poison = `batch-poison-504-${next()}`;
        const good = `batch-after-poison-504-${next()}`;
        const goodId = await secret(good, "gh-token");
        const failing = await legacyBatch({ secretRef: ref(poison) });
        const later = await legacyBatch({ secretRef: ref(good) });

        await failingLookupFor(poison, () => backfillSecretBindings());

        expect(await metaOf(later)).toMatchObject({ secretId: goodId });
        expect(await metaOf(failing)).toEqual({ secretRef: ref(poison) });
      });
    });

    // ── 1. MCP servers ──────────────────────────────────────────────────────
    describe("MCP servers saved before #480", () => {
      it("binds env and header references to the ids they resolve to now", async () => {
        const envLabel = `mcp-env-504-${next()}`;
        const hdrLabel = `mcp-hdr-504-${next()}`;
        const envId = await secret(envLabel, "env-value");
        const hdrId = await secret(hdrLabel, "hdr-value");
        const id = await legacyMcp(
          { TOKEN: ref(envLabel) },
          { Authorization: `Bearer ${ref(`global:${hdrLabel}`)}` },
        );

        await backfillSecretBindings();

        expect(await bindingsOf(id)).toEqual({ [envLabel]: envId, [`global:${hdrLabel}`]: hdrId });
        expect(await flagsFor(id)).toEqual([]);
      });

      it("closes the re-bind: once bound, a re-created label is never read", async () => {
        const label = `mcp-rebind-504-${next()}`;
        const own = await secret(label, "coord-value");
        const id = await legacyMcp({ TOKEN: ref(label) });
        await backfillSecretBindings();

        await getVaultService().delete(own);
        await secret(label, ADMIN_VALUE, "project");
        await expect(
          expandVaultRefs({ TOKEN: ref(label) }, getVaultService(), await bindingsOf(id)),
        ).rejects.toThrow(/has been deleted/);
      });

      it("flags an ambiguous label instead of guessing, and it no longer resolves", async () => {
        const label = `mcp-amb-504-${next()}`;
        await secret(label, "one", "global");
        await secret(label, "two", "project");
        const id = await legacyMcp({ TOKEN: ref(label) });

        await backfillSecretBindings();

        expect(await bindingsOf(id)).toEqual({});
        expect(await flagsFor(id)).toEqual([[{ ref: label, reason: "ambiguous" }]]);
        await expect(
          expandVaultRefs({ TOKEN: ref(label) }, getVaultService(), await bindingsOf(id)),
        ).rejects.toThrow(/not bound to a secret/);
      });

      it("flags an unresolved label and keeps the ones that did bind", async () => {
        const good = `mcp-good-504-${next()}`;
        const missing = `mcp-missing-504-${next()}`;
        const goodId = await secret(good, "good-value");
        const id = await legacyMcp({ A: ref(good), B: ref(missing) });

        await backfillSecretBindings();

        expect(await bindingsOf(id)).toEqual({ [good]: goodId });
        expect(await flagsFor(id)).toEqual([[{ ref: missing, reason: "unresolved" }]]);
        // A secret created under the missing label later is not picked up.
        await secret(missing, ADMIN_VALUE);
        await expect(
          expandVaultRefs({ B: ref(missing) }, getVaultService(), await bindingsOf(id)),
        ).rejects.toThrow(/not bound to a secret/);
      });

      it("gives a server with no references an empty binding", async () => {
        const id = await legacyMcp({ PLAIN: "value" });
        await backfillSecretBindings();
        expect(await bindingsOf(id)).toEqual({});
      });

      it("leaves a server already bound untouched, and a second run writes nothing", async () => {
        const label = `mcp-bound-504-${next()}`;
        await secret(label, "v");
        const id = (
          await db.mCPServer.create({
            data: {
              label: `mcp-504-${next()}`,
              transport: "stdio",
              command: "node",
              envJson: JSON.stringify({ T: ref(label) }),
              secretBindings: JSON.stringify({ [label]: "kept-id" }),
              createdById: "u-coord",
            },
          })
        ).id;

        await backfillSecretBindings();
        expect(await bindingsOf(id)).toEqual({ [label]: "kept-id" });
        expect(await backfillSecretBindings()).toEqual({
          mcpServersBound: 0,
          mcpServersFlagged: 0,
          batchesBound: 0,
          batchesFlagged: 0,
        });
      });
    });

    describe("MCP servers — races, soft deletes and ownership (PR #518 review)", () => {
      it("does not overwrite a server saved between the backfill's read and its write", async () => {
        const missing = `mcp-race-504-${next()}`;
        const id = await legacyMcp({ TOKEN: ref(missing) });
        const saved = JSON.stringify({ [missing]: "sec-saved-concurrently" });

        const report = await racing(
          "mCPServer",
          id,
          () => db.mCPServer.update({ where: { id }, data: { secretBindings: saved } }),
          () => backfillSecretBindings(),
        );

        expect((await db.mCPServer.findUniqueOrThrow({ where: { id } })).secretBindings).toBe(
          saved,
        );
        expect(report).toMatchObject({ mcpServersBound: 0, mcpServersFlagged: 0 });
        expect(await flagsFor(id)).toEqual([]);
      });

      it("neither binds nor flags a soft-deleted server", async () => {
        const good = `mcp-deleted-504-${next()}`;
        await secret(good, "v");
        const bindable = await legacyMcp({ A: ref(good) });
        const flaggable = await legacyMcp({ B: ref(`mcp-deleted-missing-504-${next()}`) });
        for (const id of [bindable, flaggable]) {
          await db.mCPServer.update({ where: { id }, data: { deletedAt: new Date() } });
        }

        await backfillSecretBindings();

        for (const id of [bindable, flaggable]) {
          expect(
            (await db.mCPServer.findUniqueOrThrow({ where: { id } })).secretBindings,
          ).toBeNull();
          expect(await flagsFor(id)).toEqual([]);
        }
      });

      it("binds a header reference to a secret the server's owner created", async () => {
        const label = `mcp-owned-hdr-504-${next()}`;
        const own = await secret(label, "owned-hdr-value");
        const id = await legacyMcp({}, { Authorization: `Bearer ${ref(label)}` });

        await backfillSecretBindings();

        expect(await bindingsOf(id)).toEqual({ [label]: own });
        expect(await flagsFor(id)).toEqual([]);
        await expect(
          expandVaultRefs(
            { Authorization: `Bearer ${ref(label)}` },
            getVaultService(),
            await bindingsOf(id),
            "header",
          ),
        ).resolves.toEqual({ Authorization: "Bearer owned-hdr-value" });
      });

      it("flags — never binds or sends — a header or env reference to another user's secret", async () => {
        const hdr = `mcp-foreign-hdr-504-${next()}`;
        const env = `mcp-foreign-env-504-${next()}`;
        const mine = `mcp-mine-504-${next()}`;
        await foreignSecret(hdr);
        await foreignSecret(env);
        const mineId = await secret(mine, "mine-value");
        const id = await legacyMcp(
          { TOKEN: ref(env), MINE: ref(mine) },
          { Authorization: `Bearer ${ref(hdr)}` },
        );

        const report = await backfillSecretBindings();

        expect(await bindingsOf(id)).toEqual({ [mine]: mineId });
        expect(report.mcpServersFlagged).toBeGreaterThanOrEqual(1);
        const [flags] = await flagsFor(id);
        expect(flags).toEqual(
          expect.arrayContaining([
            { ref: env, reason: "not_owned" },
            { ref: hdr, reason: "not_owned" },
          ]),
        );
        expect(flags).toHaveLength(2);
        // The audit row carries enough to act on: the server, its creator (whose
        // ownership was judged) and the repair.
        const [row] = await db.auditLog.findMany({
          where: { action: BACKFILL_FLAGGED_ACTION, targetId: id },
        });
        const server = await db.mCPServer.findUniqueOrThrow({ where: { id } });
        expect(JSON.parse(row.metadata ?? "{}")).toMatchObject({
          serverId: id,
          serverLabel: server.label,
          judgedOwnerId: "u-coord",
          remedy: expect.stringMatching(/save the MCP server again/i),
        });
        await expect(
          expandVaultRefs(
            { Authorization: `Bearer ${ref(hdr)}` },
            getVaultService(),
            await bindingsOf(id),
            "header",
          ),
        ).rejects.toThrow(/\(header Authorization\) is not bound/);
        await expect(
          expandVaultRefs({ TOKEN: ref(env) }, getVaultService(), await bindingsOf(id)),
        ).rejects.toThrow(/not bound to a secret/);
      });

      it("flags a reference that also reaches another user's secret, as #344 does at save time", async () => {
        const own = await secret(`mcp-mixed-504-${next()}`, "mine");
        // Another user's secret whose LABEL is the owner's secret id. The id
        // match wins for binding, but #344 requires every row the reference
        // can reach to be the owner's.
        await foreignSecret(own);
        const id = await legacyMcp({ TOKEN: ref(own) });

        await backfillSecretBindings();

        expect(await bindingsOf(id)).toEqual({});
        expect(await flagsFor(id)).toEqual([[{ ref: own, reason: "not_owned" }]]);
      });

      it("binds another user's secret for an owner who holds vault.reveal", async () => {
        const label = `mcp-revealer-504-${next()}`;
        const foreign = await foreignSecret(label);
        const id = (
          await db.mCPServer.create({
            data: {
              label: `mcp-504-${next()}`,
              transport: "stdio",
              command: "node",
              envJson: JSON.stringify({ TOKEN: ref(label) }),
              createdById: "u-revealer",
            },
          })
        ).id;

        await backfillSecretBindings();

        expect(await bindingsOf(id)).toEqual({ [label]: foreign });
        expect(await flagsFor(id)).toEqual([]);
      });

      it.each([
        ["deactivated", { status: "disabled" }],
        ["soft-deleted", { deletedAt: new Date() }],
      ] as const)(
        "gives an admin owner who is now %s no vault.reveal exemption",
        async (_state, change) => {
          const ownerId = `u-admin-gone-504-${next()}`;
          await db.user.create({
            data: {
              id: ownerId,
              username: ownerId,
              displayName: ownerId,
              email: `${ownerId}@example.test`,
            },
          });
          const adminRole = await db.role.findUniqueOrThrow({ where: { key: "admin" } });
          await db.userRole.create({
            data: { userId: ownerId, roleId: adminRole.id, source: "local" },
          });
          await db.user.update({ where: { id: ownerId }, data: change });
          const label = `mcp-gone-admin-504-${next()}`;
          await foreignSecret(label);
          const id = await legacyMcp({ TOKEN: ref(label) });
          await db.mCPServer.update({ where: { id }, data: { createdById: ownerId } });

          await backfillSecretBindings();

          expect(await bindingsOf(id)).toEqual({});
          expect(await flagsFor(id)).toEqual([[{ ref: label, reason: "not_owned" }]]);
        },
      );

      it("flags every reference of a server with no owner", async () => {
        const label = `mcp-orphan-504-${next()}`;
        await secret(label, "v");
        const id = await legacyMcp({ TOKEN: ref(label) });
        await db.mCPServer.update({ where: { id }, data: { createdById: null } });

        await backfillSecretBindings();

        expect(await bindingsOf(id)).toEqual({});
        expect(await flagsFor(id)).toEqual([[{ ref: label, reason: "not_owned" }]]);
      });
    });

    // ── 1b. Publish batches ─────────────────────────────────────────────────
    describe("publish batches created before #480", () => {
      it("binds a live batch's reference to the id it resolves to now", async () => {
        const label = `batch-504-${next()}`;
        const own = await secret(label, "gh-token");
        const id = await legacyBatch({ secretRef: ref(label), draftIds: ["d1"] });

        await backfillSecretBindings();

        const meta = await metaOf(id);
        expect(meta).toMatchObject({ secretRef: ref(label), secretId: own, draftIds: ["d1"] });
        expect(batchTokenSource(meta)).toEqual({ secretRef: ref(label), boundSecretId: own });
      });

      it("flags an ambiguous batch reference and strips its label path", async () => {
        const label = `batch-amb-504-${next()}`;
        await secret(label, "one", "global");
        await secret(label, "two", "project");
        const id = await legacyBatch({ secretRef: ref(label) });

        await backfillSecretBindings();

        const meta = await metaOf(id);
        expect(meta).toMatchObject({ secretId: null, secretBindingFlag: "ambiguous" });
        expect(await flagsFor(id)).toEqual([[{ ref: label, reason: "ambiguous" }]]);
        expect(batchTokenSource(meta)).toEqual({ secretRef: null, boundSecretId: null });
      });

      it("flags an unresolved batch reference", async () => {
        const label = `batch-missing-504-${next()}`;
        const id = await legacyBatch({ secretRef: ref(label) });
        await backfillSecretBindings();
        expect(await metaOf(id)).toMatchObject({ secretId: null, secretBindingFlag: "unresolved" });
        expect(await flagsFor(id)).toEqual([[{ ref: label, reason: "unresolved" }]]);
      });

      it("leaves dry runs, already-bound batches and malformed refs alone", async () => {
        const label = `batch-skip-504-${next()}`;
        await secret(label, "v");
        const dry = await legacyBatch({ secretRef: ref(label) }, true);
        const bound = await legacyBatch({ secretRef: ref(label), secretId: null });
        const malformed = await legacyBatch({ secretRef: "not-a-ref" });

        await backfillSecretBindings();

        expect(await metaOf(dry)).toEqual({ secretRef: ref(label) });
        expect(await metaOf(bound)).toEqual({ secretRef: ref(label), secretId: null });
        expect(await metaOf(malformed)).toEqual({ secretRef: "not-a-ref" });
      });

      it("leaves an archived batch alone", async () => {
        const label = `batch-archived-504-${next()}`;
        await secret(label, "v");
        const id = await legacyBatch({ secretRef: ref(label) });
        await db.publishBatch.update({ where: { id }, data: { archived: true } });

        await backfillSecretBindings();

        expect(await metaOf(id)).toEqual({ secretRef: ref(label) });
      });

      it("does not overwrite a batch changed between the backfill's read and its write", async () => {
        const label = `batch-race-504-${next()}`;
        await secret(label, "v");
        const id = await legacyBatch({ secretRef: ref(label) });
        const concurrent = { secretRef: ref(label), secretId: "sec-written-concurrently" };

        const report = await racing(
          "publishBatch",
          id,
          () =>
            db.publishBatch.update({
              where: { id },
              data: { metadata: JSON.stringify(concurrent) },
            }),
          () => backfillSecretBindings(),
        );

        expect(await metaOf(id)).toEqual(concurrent);
        expect(report).toMatchObject({ batchesBound: 0, batchesFlagged: 0 });
      });

      it("binds another user's secret for a batch bound for the public GitHub API, as #358 does", async () => {
        // #358 exempts api.github.com: the token goes to the service that
        // issued it. Flagging it here would strip a coordinator's team token
        // and leave the batch unarchivable with closeIssues (TOKEN_REQUIRED).
        for (const baseUrl of [null, "https://api.github.com"]) {
          const label = `batch-foreign-public-504-${next()}`;
          const foreign = await foreignSecret(label);
          const id = await legacyBatch({ secretRef: ref(label) }, false, baseUrl);

          await backfillSecretBindings();

          const meta = await metaOf(id);
          expect(meta).toMatchObject({ secretRef: ref(label), secretId: foreign });
          expect(meta).not.toHaveProperty("secretBindingFlag");
          expect(await flagsFor(id)).toEqual([]);
        }
      });

      it("flags a batch whose caller-chosen host would receive a secret its starter did not create", async () => {
        const label = `batch-foreign-ghe-504-${next()}`;
        await foreignSecret(label);
        const id = await legacyBatch(
          { secretRef: ref(label) },
          false,
          "https://ghe.example.test/api/v3",
        );

        await backfillSecretBindings();

        expect(await metaOf(id)).toMatchObject({ secretId: null, secretBindingFlag: "not_owned" });
        expect(await flagsFor(id)).toEqual([[{ ref: label, reason: "not_owned" }]]);
      });

      describe("a flagged batch gets no token (executeBatch, archiveBatch)", () => {
        /**
         * The attack the flag closes: the reference reached nothing at backfill
         * time, and a secret is created under its label afterwards. Read by
         * label, `meta.secretRef` would now resolve — and be sent to GitHub.
         */
        const flaggedBatch = async () => {
          const label = `batch-flagged-use-504-${next()}`;
          const id = await legacyBatch({ secretRef: ref(label) });
          await backfillSecretBindings();
          expect(await metaOf(id)).toMatchObject({ secretBindingFlag: "unresolved" });
          await secret(label, ADMIN_VALUE);
          state.sent.length = 0;
          return id;
        };

        it("executeBatch refuses to publish it", async () => {
          const id = await flaggedBatch();
          await expect(executeBatch({ batchId: id, actorId: "u-coord" })).rejects.toMatchObject({
            code: "TOKEN_REQUIRED",
          });
          expect(state.sent).toEqual([]);
        });

        it("archiveBatch refuses to close its issues", async () => {
          const id = await flaggedBatch();
          await expect(
            archiveBatch({
              batchId: id,
              projectId: PROJ,
              input: { reason: "rollback", closeIssues: true },
              actorId: "u-coord",
              actorRole: "coordinator",
            }),
          ).rejects.toMatchObject({ code: "TOKEN_REQUIRED" });
          expect(state.sent).toEqual([]);
          expect((await db.publishBatch.findUniqueOrThrow({ where: { id } })).archived).toBe(false);
        });
      });
    });

    // ── 2. Jira reads the stored id only ─────────────────────────────────────
    describe("stored secret ids are never re-resolved by label", () => {
      it("Jira: a secret labelled with the deleted secret's id is never used", async () => {
        const own = await secret(`jira-504-${next()}`, "jira-token");
        const conn = await db.jiraConnection.create({
          data: {
            projectId: PROJ,
            label: `jira-504-${next()}`,
            edition: "cloud",
            baseUrl: "https://jira.example.test",
            username: "u",
            secretId: own,
            createdById: "u-coord",
          },
        });
        await buildJiraClientForConnection(conn.id);
        expect(state.sent).toEqual(["jira-token"]);

        state.sent.length = 0;
        await squatOnId(own);
        await expect(buildJiraClientForConnection(conn.id)).rejects.toThrow(/not found/);
        expect(state.sent).toEqual([]);
      });
    });
  },
);
