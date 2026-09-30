/**
 * #552 — a confirmed foreign-owner rotation (`POST /api/vault/:id/rotate`) and
 * a write that binds the same secret somewhere new cannot interleave.
 *
 * Proven through the REAL vault router, vault service and binding guard
 * (`assertSecretBindingAllowed`) against a REAL SQLite database built from the
 * migration chain. The binding write is the guard followed by the connector
 * row it approves, exactly the two steps a connector route takes; each
 * interleaving is forced by running one side inside the other's gap:
 *
 *   - a binding write landing between the rotation's read and its write
 *     refuses the rotation (409, value and owner unchanged, nothing audited);
 *   - a binding write whose check passed before the rotation began refuses it
 *     until its window closes;
 *   - a rotation that lands first serializes the binding write after it: the
 *     old owner's check reads the new owner and refuses.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { assertSecretBindingAllowed } = await import("../src/lib/vault/secret-binding.js");
const { BINDING_WRITE_WINDOW_MS, SECRET_BINDING_WINDOW_EXPIRED } =
  await import("../src/lib/vault/binding-write-mark.js");
const { authorizeAndBindSecretRefs } = await import("../src/lib/vault/bound-secret.js");
const { assertDbSecretBinding, assertRepoSecretBinding } =
  await import("../src/lib/connectors/connector-secret-binding.js");
const { assertPublishSecretBinding } =
  await import("../src/lib/publishing/publish-secret-binding.js");
const {
  assertMcpCreateSecretBinding,
  assertMcpImportSecretBinding,
  assertMcpRebindSecretBinding,
  assertMcpUpdateSecretBinding,
} = await import("../src/lib/mcp/secret-binding.js");
const { buildImportPlan, executeImport } = await import("../src/lib/mcp/mcp-importer.js");
type Registry = Parameters<typeof executeImport>[1];

const OWNER_VALUE = "coordinator-own-token-552";
const ADMIN_VALUE = "admin-real-token-552";
const COORD = { userId: "u-coord", role: "coordinator" as const };
const OTHER = { userId: "u-other", role: "coordinator" as const };
const ADMIN = { userId: "u-admin", role: "admin" as const };

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#552 — a foreign-owner rotation and a binding write on the same secret cannot interleave",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let adminToken = "";
    let n = 0;
    let lastLabel = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/vault", vaultRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const rotate = (id: string, body: Record<string, unknown>) =>
      request(app())
        .post(`/api/vault/${id}/rotate`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body);
    const plaintextOf = async (id: string) => (await getVaultService().read(id)).plaintext;
    const secretRow = (id: string) => db.secret.findUniqueOrThrow({ where: { id } });
    const rotateAudit = async (id: string) => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      return db.auditLog.findMany({
        where: { action: "vault.rotate", targetType: "secret", targetId: id },
      });
    };
    const newSecret = async (createdById: string) => {
      n += 1;
      lastLabel = `s552-${n}`;
      return (await getVaultService().create(lastLabel, OWNER_VALUE, "global", { createdById })).id;
    };
    const bindDb = (id: string, secretId: string, host: string) =>
      db.databaseConnection.create({
        data: { id, projectId: "proj-1", label: id, driver: "postgres", host, secretId },
      });
    const pg = (id: string, host: string) => ({
      type: "db_connector",
      id,
      destination: `postgres://${host}`,
    });
    /** The owner binding their secret to a new connector: the guard, then the write. */
    const ownerBinds = async (secretId: string, connectorId: string, host: string) => {
      await assertSecretBindingAllowed(
        COORD,
        { before: [], after: [secretId], destinationChanged: true },
        { target: { type: "db_connector", id: "new" } },
      );
      await bindDb(connectorId, secretId, host);
    };
    /**
     * Run `hook` once, just `before` or `after` the binding check's ownership
     * read — the candidate-row read, the one that selects `name` (the stamp's
     * own id lookup does not). The hook runs against the real client.
     */
    const onOwnershipRead = (hook: () => Promise<void>, when: "before" | "after") => {
      const realSecret = db.secret;
      state.db = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "secret") return Reflect.get(target, prop, receiver);
          return new Proxy(realSecret, {
            get(t, p, r) {
              if (p !== "findMany") return Reflect.get(t, p, r);
              return async (...args: Parameters<typeof realSecret.findMany>) => {
                if (!(args[0]?.select as { name?: boolean } | undefined)?.name) {
                  return realSecret.findMany(...args);
                }
                state.db = db;
                if (when === "before") await hook();
                const rows = await realSecret.findMany(...args);
                if (when === "after") await hook();
                return rows;
              };
            },
          });
        },
      });
    };
    /** Run `between` inside the rotation, after its bindings read and before its UPDATE. */
    const betweenReadAndWrite = (between: () => Promise<void>) => {
      const svc = getVaultService();
      const real = svc.rotate.bind(svc);
      return vi.spyOn(svc, "rotate").mockImplementationOnce(async (...args) => {
        await between();
        return real(...args);
      });
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("552-vault-rotate-race");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();
      for (const [id, displayName] of [
        ["u-admin", "Ada Admin"],
        ["u-coord", "Cora Coordinator"],
        ["u-other", "Olly Other"],
      ]) {
        await db.user.create({
          data: { id, username: id, displayName, email: `${id}@example.test` },
        });
      }
      await db.project.create({
        data: { id: "proj-1", name: "proj-1", slug: "proj-1", createdById: "u-coord" },
      });
      adminToken = issueTokens({
        userId: "u-admin",
        username: "u-admin",
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a binding write landing between the rotation's read and its write refuses the rotation", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-552-a", id, "a.coord.example");

      const spy = betweenReadAndWrite(() => ownerBinds(id, "db-552-a2", "evil.coord.example"));
      let res: request.Response;
      try {
        res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindings: [pg("db-552-a", "a.coord.example")],
        });
      } finally {
        spy.mockRestore();
      }

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDINGS_CHANGED");
      expect(res.body.error.message).toContain("evil.coord.example");
      expect(
        (res.body.error.details.bindings as Array<{ id: string }>).map((b) => b.id).sort(),
      ).toEqual(["db-552-a", "db-552-a2"]);
      // Read back: the admin's value went nowhere and the owner is unchanged.
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect((await secretRow(id)).createdById).toBe("u-coord");
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    it("a binding write whose check passed before the rotation began refuses it while its window is open", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-552-b", id, "b.coord.example");
      // The owner's guard passes; their connector write has not landed yet.
      await assertSecretBindingAllowed(
        COORD,
        { before: [], after: [id], destinationChanged: true },
        { target: { type: "db_connector", id: "new" } },
      );

      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: [pg("db-552-b", "b.coord.example")],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDING_IN_PROGRESS");
      expect(res.body.error.message).toContain("Cora Coordinator");
      // The way out when the owner keeps binding it (PR #587 review).
      expect(res.body.error.message).toContain("disable their account first");
      await bindDb("db-552-b2", id, "evil.coord.example");

      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect((await secretRow(id)).createdById).toBe("u-coord");
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    it("a rotation attempted between the owner's ownership check and their write is refused", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-552-g", id, "g.coord.example");
      // Run the whole rotation inside the owner's guard, right after it reads
      // who owns the secret: the stamp must already be on the row by then.
      let res: request.Response | undefined;
      onOwnershipRead(async () => {
        res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindings: [pg("db-552-g", "g.coord.example")],
        });
      }, "after");
      try {
        await ownerBinds(id, "db-552-g2", "evil.coord.example");
      } finally {
        state.db = db;
      }

      expect(res?.status).toBe(409);
      expect(res?.body.error.code).toBe("VAULT_ROTATE_BINDING_IN_PROGRESS");
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect((await secretRow(id)).createdById).toBe("u-coord");
    });

    it("once the window has closed, the confirmed rotation lands", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-552-c", id, "c.coord.example");
      await assertSecretBindingAllowed(
        COORD,
        { before: [], after: [id], destinationChanged: true },
        { target: { type: "db_connector", id: "new" } },
      );
      const stamped = (await secretRow(id)).bindingWriteUntil;
      expect(stamped).not.toBeNull();
      expect(stamped!.getTime()).toBeGreaterThan(Date.now() + BINDING_WRITE_WINDOW_MS - 10_000);
      await db.secret.update({
        where: { id },
        data: { bindingWriteUntil: new Date(Date.now() - 1) },
      });

      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: [pg("db-552-c", "c.coord.example")],
      });
      expect(res.status).toBe(200);
      expect(await plaintextOf(id)).toBe(ADMIN_VALUE);
      expect((await secretRow(id)).createdById).toBe("u-admin");
    });

    it("a rotation that lands first serializes the binding write after it: the old owner is refused", async () => {
      const id = await newSecret("u-coord");
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: [],
      });
      expect(res.status).toBe(200);

      await expect(ownerBinds(id, "db-552-d", "evil.coord.example")).rejects.toMatchObject({
        statusCode: 403,
        code: "SECRET_BINDING_FORBIDDEN",
      });
      // The stamp is conditional on ownership: the refused write left none.
      expect((await secretRow(id)).bindingWriteUntil).toBeNull();
      expect(await db.databaseConnection.count({ where: { id: "db-552-d" } })).toBe(0);
    });

    it("a user who does not own the secret cannot hold off its rotation", async () => {
      const id = await newSecret("u-coord");
      await expect(
        assertSecretBindingAllowed(
          OTHER,
          { before: [], after: [id], destinationChanged: true },
          { target: { type: "db_connector", id: "new" } },
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect((await secretRow(id)).bindingWriteUntil).toBeNull();
      const res = await rotate(id, {
        value: ADMIN_VALUE,
        confirmForeignOwner: true,
        confirmedBindings: [],
      });
      expect(res.status).toBe(200);
    });

    it("a reference kept verbatim while nothing moves binds nothing new and stamps nothing", async () => {
      const id = await newSecret("u-coord");
      await assertSecretBindingAllowed(
        COORD,
        { before: [id], after: [id], destinationChanged: false },
        { target: { type: "db_connector", id: "db-552-f" } },
      );
      expect((await secretRow(id)).bindingWriteUntil).toBeNull();
      // Moving the same reference to a new destination does bind it anew.
      await assertSecretBindingAllowed(
        COORD,
        { before: [id], after: [id], destinationChanged: true },
        { target: { type: "db_connector", id: "db-552-f" } },
      );
      expect((await secretRow(id)).bindingWriteUntil).not.toBeNull();
    });

    it("an admin's binding write (vault.reveal) stamps the secret too", async () => {
      const id = await newSecret("u-coord");
      await assertSecretBindingAllowed(
        ADMIN,
        { before: [], after: [lastLabel], destinationChanged: true },
        { target: { type: "db_connector", id: "new" } },
      );
      expect((await secretRow(id)).bindingWriteUntil).not.toBeNull();
    });

    it("a secret that appears under the label after the stamp refuses the binding write", async () => {
      n += 1;
      const label = `s552-late-${n}`;
      // Between the stamp and the ownership read, the caller's own secret
      // appears under the label, so it was never stamped.
      let appeared = 0;
      onOwnershipRead(async () => {
        appeared += 1;
        await getVaultService().create(label, OWNER_VALUE, "global", { createdById: "u-coord" });
      }, "before");
      try {
        await expect(
          assertSecretBindingAllowed(
            COORD,
            { before: [], after: [label], destinationChanged: true },
            { target: { type: "db_connector", id: "new" } },
          ),
        ).rejects.toMatchObject({ statusCode: 409, code: "SECRET_BINDING_CHANGED" });
      } finally {
        state.db = db;
      }
      expect(appeared).toBe(1);
    });

    it("a foreign rotation whose secret is deleted before its write is still 404", async () => {
      const id = await newSecret("u-coord");
      const spy = betweenReadAndWrite(() => getVaultService().delete(id));
      let res: request.Response;
      try {
        res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindings: [],
        });
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("SECRET_NOT_FOUND");
    });

    it("a binding check between the rotation's read and its write, whose write has not landed, is IN_PROGRESS — not CHANGED", async () => {
      const id = await newSecret("u-coord");
      await bindDb("db-552-h", id, "h.coord.example");
      // The owner's check stamps the secret mid-rotation; their write is still pending,
      // so the live bindings are exactly the ones the admin confirmed.
      const spy = betweenReadAndWrite(async () => {
        await assertSecretBindingAllowed(
          COORD,
          { before: [], after: [id], destinationChanged: true },
          { target: { type: "db_connector", id: "new" } },
        );
      });
      let res: request.Response;
      try {
        res = await rotate(id, {
          value: ADMIN_VALUE,
          confirmForeignOwner: true,
          confirmedBindings: [pg("db-552-h", "h.coord.example")],
        });
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("VAULT_ROTATE_BINDING_IN_PROGRESS");
      expect(res.body.error.message).toContain("disable their account first");
      expect((res.body.error.details.bindings as Array<{ id: string }>).map((b) => b.id)).toEqual([
        "db-552-h",
      ]);
      expect(await plaintextOf(id)).toBe(OWNER_VALUE);
      expect((await secretRow(id)).createdById).toBe("u-coord");
      expect(await rotateAudit(id)).toHaveLength(0);
    });

    // ── PR #587 review — every binding entry point stamps, before its ownership
    // read, without touching `updatedAt`, and returns the window it stamped. ──
    const ref = (body: string) => `\${vault:${body}}`;
    const mcpRow = async (env: Record<string, string>, secretBindings: Record<string, string>) =>
      (
        await db.mCPServer.create({
          data: {
            label: `mcp-552-${(n += 1)}`,
            transport: "stdio",
            command: "node",
            envJson: JSON.stringify(env),
            secretBindings: JSON.stringify(secretBindings),
            createdById: "u-coord",
          },
        })
      ).id;
    const entryPoints: Array<[string, (s: { id: string; label: string }) => Promise<Date | null>]> =
      [
        [
          "assertSecretBindingAllowed",
          ({ id }) =>
            assertSecretBindingAllowed(
              COORD,
              { before: [], after: [id], destinationChanged: true },
              { target: { type: "db_connector", id: "new" } },
            ),
        ],
        [
          "assertDbSecretBinding (create)",
          async ({ label }) =>
            (await assertDbSecretBinding(COORD, "proj-1", null, { secretRef: ref(label) })).until,
        ],
        [
          "assertRepoSecretBinding (create)",
          async ({ id }) =>
            (await assertRepoSecretBinding(COORD, "proj-1", null, { secretRef: ref(id) })).until,
        ],
        [
          "assertPublishSecretBinding (caller-chosen host)",
          ({ label }) =>
            assertPublishSecretBinding(
              COORD,
              { secretRef: ref(label), baseUrl: "https://ghe.coord.example/api/v3" },
              { type: "publish_batch", id: "new" },
            ),
        ],
        [
          "authorizeAndBindSecretRefs",
          async ({ label }) =>
            (
              await authorizeAndBindSecretRefs(
                COORD,
                { before: [], after: [label], destinationChanged: true },
                { target: { type: "mcp_server", id: "new" } },
              )
            ).until,
        ],
        [
          "authorizeAndBindSecretRefs (vault.reveal)",
          async ({ label }) =>
            (
              await authorizeAndBindSecretRefs(
                ADMIN,
                { before: [], after: [label], destinationChanged: true },
                { target: { type: "mcp_server", id: "new" } },
              )
            ).until,
        ],
        [
          "MCP create",
          async ({ label }) =>
            (
              await assertMcpCreateSecretBinding(COORD, {
                env: { API_KEY: ref(label) },
                label: "mcp-552-new",
              })
            ).until,
        ],
        [
          "MCP PATCH adding a reference",
          async ({ label }) =>
            (await assertMcpUpdateSecretBinding(COORD, await mcpRow({}, {}), {
              env: { API_KEY: ref(label) },
            }))!.until,
        ],
        [
          "MCP PATCH moving a bound reference",
          async ({ id, label }) =>
            (await assertMcpUpdateSecretBinding(
              COORD,
              await mcpRow({ API_KEY: ref(label) }, { [label]: id }),
              { command: "evil" },
            ))!.until,
        ],
        [
          "MCP re-bind",
          async ({ label }) =>
            (await assertMcpRebindSecretBinding(COORD, await mcpRow({ API_KEY: ref(label) }, {})))!
              .until,
        ],
        [
          "mcp.json import",
          async ({ label }) => {
            const entry = `mcp-552-imp-${(n += 1)}`;
            const plan = await buildImportPlan({
              mcpServers: { [entry]: { command: "node", env: { API_KEY: ref(label) } } },
            });
            return (await assertMcpImportSecretBinding(COORD, plan)).until.get(entry) ?? null;
          },
        ],
      ];

    it.each(entryPoints)(
      "%s stamps the secret before its ownership read, and leaves updatedAt alone",
      async (_name, run) => {
        const id = await newSecret("u-coord");
        const label = lastLabel;
        const updatedAt = (await secretRow(id)).updatedAt;
        // Long enough that a bumped `updatedAt` could not read back equal.
        await new Promise((r) => setTimeout(r, 15));
        let stampAtRead: Date | null | undefined;
        onOwnershipRead(async () => {
          stampAtRead = (await secretRow(id)).bindingWriteUntil;
        }, "before");
        let until: Date | null;
        try {
          until = await run({ id, label });
        } finally {
          state.db = db;
        }
        const row = await secretRow(id);
        expect(row.bindingWriteUntil).not.toBeNull();
        expect(until).toEqual(row.bindingWriteUntil);
        expect(until!.getTime()).toBeGreaterThan(Date.now() + BINDING_WRITE_WINDOW_MS - 10_000);
        // The candidate read that judges (or, for vault.reveal, binds) the
        // secret already sees this write's stamp.
        expect(stampAtRead).toEqual(until);
        expect(row.updatedAt).toEqual(updatedAt);
      },
    );

    it("an mcp.json import entry written after its window closed fails alone, and withdraws what it vaulted", async () => {
      await newSecret("u-coord");
      const firstLabel = lastLabel;
      await newSecret("u-coord");
      const secondLabel = lastLabel;
      n += 1;
      const early = `mcp-552-early-${n}`;
      const late = `mcp-552-late-${n}`;
      const mcpJson = {
        mcpServers: {
          [early]: { command: "node", env: { API_KEY: ref(firstLabel) } },
          [late]: {
            command: "node",
            env: { API_KEY: ref(secondLabel), GITHUB_TOKEN: "ghp_late552plaintext" },
          },
        },
      };
      const check = await assertMcpImportSecretBinding(COORD, await buildImportPlan(mcpJson));
      expect(check.until.get(late)).toBeInstanceOf(Date);
      // Writing the first entry is slow: the clock passes the second one's window.
      const created: string[] = [];
      const registry = {
        create: vi.fn(async (input: { label: string }) => {
          created.push(input.label);
          vi.setSystemTime(check.until.get(late)!.getTime());
          return { id: `srv-${input.label}`, label: input.label };
        }),
      } as unknown as Registry;
      const secretsBefore = await db.secret.count({ where: { deletedAt: null } });
      vi.useFakeTimers({ toFake: ["Date"] });
      let result: Awaited<ReturnType<typeof executeImport>>;
      try {
        result = await executeImport(
          mcpJson,
          registry,
          { id: "u-coord" },
          { secretBindings: check },
        );
      } finally {
        vi.useRealTimers();
      }
      expect(created).toEqual([early]);
      expect(result.created).toEqual([{ id: `srv-${early}`, label: early }]);
      expect(result.errors).toEqual([
        expect.objectContaining({ label: late, code: SECRET_BINDING_WINDOW_EXPIRED }),
      ]);
      // The late entry's auto-vaulted token was withdrawn, not left orphaned.
      expect(await db.secret.count({ where: { deletedAt: null } })).toBe(secretsBefore);
    });
  },
);
