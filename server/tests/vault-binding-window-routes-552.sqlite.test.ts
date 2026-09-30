/**
 * #552 — every route that binds a vault secret refuses its write once the
 * binding check's window has closed (PR #587 adversarial panel).
 *
 * A binding check stamps `secrets.bindingWriteUntil` (`markBindingWrite`) and a
 * confirmed foreign-owner rotation is held off only until that instant, so a
 * write landing after it could follow a rotation the admin confirmed without
 * it. Each route runs `assertBindingWriteWindowOpen(until)` right before its
 * write. This table drives every one of those call sites through its REAL
 * router, REAL auth, REAL vault and REAL guard against a REAL SQLite database
 * built from the migration chain:
 *
 *   - the check passes and stamps; the clock then moves to `until` (the seam is
 *     `markBindingWrite` itself — the real one runs, then the fake clock jumps)
 *     before the write: 409 SECRET_BINDING_WINDOW_EXPIRED, nothing written;
 *   - the same request inside its window writes — so a missing check is what
 *     turns the first case red, not a fixture that could never write.
 *
 * `POST /api/projects` creates the project either way and reports the refused
 * repo link in `primaryRepoError` (`primaryRepoLinkError`).
 *
 * Only the network edge is stubbed: DNS pinning and the Octokit factory, which
 * records the token it was handed — the proof a refused request sent nothing.
 */
import express from "express";
import request from "supertest";
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
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    tokensSent: [] as Array<{ baseUrl: string; token: string }>,
    /** Called with every window a binding check stamps. */
    onStamp: null as null | ((until: Date) => void),
  };
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
// The seam: the real stamp runs, then the test may move the clock past it.
vi.mock("../src/lib/vault/binding-write-mark.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/vault/binding-write-mark.js")>();
  return {
    ...actual,
    markBindingWrite: async (...args: Parameters<typeof actual.markBindingWrite>) => {
      const until = await actual.markBindingWrite(...args);
      if (until) state.onStamp?.(until);
      return until;
    },
  };
});
vi.mock("../src/lib/connectors/network-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    assertConnectorHostAllowed: async () => undefined,
    resolveAndAssertConnectorHost: async (hostname: string) => ({
      hostname,
      address: "203.0.113.7",
      family: 4,
    }),
  };
});
vi.mock("../src/lib/publishing/octokit-factory.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    acquirePublishOctokit: async (opts: { baseUrl: string; token: string }) => {
      state.tokensSent.push({ baseUrl: opts.baseUrl, token: opts.token });
      throw new Error("network stubbed in #552 test");
    },
  };
});

const { connectorsRouter } = await import("../src/routes/connectors.js");
const { projectsRouter } = await import("../src/routes/projects.js");
const { mcpRouter } = await import("../src/routes/mcp.js");
const { publishingRouter } = await import("../src/routes/publishing.js");
const { jiraRouter } = await import("../src/routes/jira.js");
const { testManagementRouter } = await import("../src/routes/test-management.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getVaultService, __resetVaultSingleton } =
  await import("../src/lib/vault/vault-service.js");
const { getAuditService } = await import("../src/lib/audit/audit-service.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");
const { SECRET_BINDING_WINDOW_EXPIRED } = await import("../src/lib/vault/binding-write-mark.js");

type Method = "get" | "post" | "patch";

const PROJ = "proj-552-window-01";
const OWN_LABEL = "coord-token-552-window";
const OWN_VALUE = "coord-token-value-552";
const EVIL = "https://attacker.example.test/api/v3";
const ref = (body: string) => `\${vault:${body}}`;

/**
 * One call site: `send` is the request that binds the caller's own secret
 * anew; `written` reads back whether its write landed.
 */
interface Row {
  site: string;
  setup: () => Promise<string>;
  send: (fixture: string) => Promise<request.Response>;
  /** The status the request answers inside its window. */
  okStatus: number;
  written: (fixture: string, res: request.Response) => Promise<boolean>;
  /** `POST /api/projects` reports a refused link instead of failing the request. */
  expired?: (res: request.Response) => void;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#552 — every binding route refuses a write that lands after its window",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let COORD = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId/connectors", connectorsRouter());
      a.use("/api/projects/:projectId/publishing", publishingRouter());
      a.use("/api/projects", projectsRouter());
      a.use("/api/mcp", mcpRouter());
      a.use("/api/jira", jiraRouter());
      a.use("/api/test-management", testManagementRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (method: Method, url: string, body?: unknown) => {
      const r = request(app())[method](url).set("Authorization", `Bearer ${COORD}`);
      return body === undefined ? r : r.send(body as object);
    };
    const expectOk = (res: request.Response, status: number) =>
      expect(res.status, JSON.stringify(res.body)).toBe(status);

    let seq = 0;
    const next = () => (seq += 1);

    const connectors = `/api/projects/${PROJ}/connectors`;
    const repoBody = () => ({
      label: `repo-552-${next()}`,
      provider: "github_enterprise",
      ownerOrOrg: "octo",
      repoName: "app",
      apiBaseUrl: "https://ghe.coord.example.test/api/v3",
      secretRef: ref(OWN_LABEL),
      autoIngest: false,
    });
    const dbBody = () => ({
      label: `db-552-${next()}`,
      driver: "postgres",
      host: "db.coord.example.test",
      port: 5432,
      secretRef: ref(OWN_LABEL),
    });
    const mcpBody = () => ({
      scope: "global",
      label: `mcp-552-${next()}`,
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { API_KEY: ref(OWN_LABEL) },
    });
    const created = async (res: Promise<request.Response>) => {
      const r = await res;
      expectOk(r, 201);
      return r.body.data.id as string;
    };

    const rows: Row[] = [
      {
        site: "connectors.ts POST /repos",
        setup: async () => JSON.stringify(repoBody()),
        send: (f) => call("post", `${connectors}/repos`, JSON.parse(f)),
        okStatus: 201,
        written: async (f) =>
          (await db.repoConnection.count({ where: { label: JSON.parse(f).label } })) > 0,
      },
      {
        site: "connectors.ts PATCH /repos/:id",
        setup: () => created(call("post", `${connectors}/repos`, repoBody())),
        send: (id) =>
          call("patch", `${connectors}/repos/${id}`, {
            apiBaseUrl: "https://ghe.moved.example.test/api/v3",
          }),
        okStatus: 200,
        written: async (id) =>
          (await db.repoConnection.findUniqueOrThrow({ where: { id } })).apiBaseUrl ===
          "https://ghe.moved.example.test/api/v3",
      },
      {
        site: "connectors.ts POST /dbs",
        setup: async () => JSON.stringify(dbBody()),
        send: (f) => call("post", `${connectors}/dbs`, JSON.parse(f)),
        okStatus: 201,
        written: async (f) =>
          (await db.databaseConnection.count({ where: { label: JSON.parse(f).label } })) > 0,
      },
      {
        site: "connectors.ts PATCH /dbs/:id",
        setup: () => created(call("post", `${connectors}/dbs`, dbBody())),
        send: (id) => call("patch", `${connectors}/dbs/${id}`, { host: "db.moved.example.test" }),
        okStatus: 200,
        written: async (id) =>
          (await db.databaseConnection.findUniqueOrThrow({ where: { id } })).host ===
          "db.moved.example.test",
      },
      {
        site: "mcp.ts POST /",
        setup: async () => JSON.stringify(mcpBody()),
        send: (f) => call("post", "/api/mcp", JSON.parse(f)),
        okStatus: 201,
        written: async (f) =>
          (await db.mCPServer.count({ where: { label: JSON.parse(f).label } })) > 0,
      },
      {
        site: "mcp.ts PATCH /:id",
        setup: () => created(call("post", "/api/mcp", mcpBody())),
        send: (id) => call("patch", `/api/mcp/${id}`, { command: "python" }),
        okStatus: 200,
        written: async (id) =>
          (await db.mCPServer.findUniqueOrThrow({ where: { id } })).command === "python",
      },
      {
        site: "mcp.ts POST /:id/rebind-secrets",
        // A server saved before #480: its reference is flagged, not bound.
        setup: async () =>
          (
            await db.mCPServer.create({
              data: {
                label: `mcp-552-legacy-${next()}`,
                transport: "stdio",
                command: "node",
                envJson: JSON.stringify({ API_KEY: ref(OWN_LABEL) }),
                secretBindings: "{}",
                createdById: "u-coord",
              },
            })
          ).id,
        send: (id) => call("post", `/api/mcp/${id}/rebind-secrets`),
        okStatus: 200,
        written: async (id) =>
          (await db.mCPServer.findUniqueOrThrow({ where: { id } })).secretBindings !== "{}",
      },
      {
        site: "projects.ts POST / (primary repo)",
        setup: async () => `proj-552-new-${next()}`,
        send: (name) =>
          call("post", "/api/projects", {
            name,
            slug: name,
            primaryRepo: {
              ownerOrOrg: "octo",
              repoName: "app",
              apiBaseUrl: "https://ghe.coord.example.test/api/v3",
              secretRef: ref(OWN_LABEL),
            },
          }),
        okStatus: 201,
        written: async (_name, res) => {
          const projectId = res.body?.data?.id as string | undefined;
          if (!projectId) return false;
          return (await db.repoConnection.count({ where: { projectId } })) > 0;
        },
        // The project is created; the refused link is reported, not thrown.
        expired: (res) => {
          expectOk(res, 201);
          expect(res.body.data.primaryRepo).toBeNull();
          expect(res.body.data.primaryRepoError).toEqual({
            code: SECRET_BINDING_WINDOW_EXPIRED,
            message: expect.stringContaining("took too long"),
          });
        },
      },
      {
        site: "projects.ts POST /:id/github/projects-v2-boards",
        setup: async () => "",
        send: () =>
          call("post", `/api/projects/${PROJ}/github/projects-v2-boards`, {
            secretRef: ref(OWN_LABEL),
            targetOwner: "octo",
            targetBaseUrl: EVIL,
          }),
        // The stubbed network fails the listing itself; the token was sent.
        okStatus: 500,
        written: async () => state.tokensSent.some((t) => t.token === OWN_VALUE),
      },
      {
        site: "publishing.ts POST /batches",
        setup: async () => `repo-552-${next()}`,
        send: async (targetRepo) => {
          const draft = await db.issueDraft.create({
            data: { projectId: PROJ, title: `Draft ${next()}`, body: "b", status: "approved" },
          });
          return call("post", `/api/projects/${PROJ}/publishing/batches`, {
            targetOwner: "octo",
            targetRepo,
            provider: "github_enterprise",
            draftIds: [draft.id],
            dryRun: false,
            secretRef: ref(OWN_LABEL),
            targetBaseUrl: EVIL,
          });
        },
        // The stubbed network fails the run itself; the batch and token landed.
        okStatus: 500,
        written: async (targetRepo) =>
          (await db.publishBatch.count({ where: { projectId: PROJ, targetRepo } })) > 0 ||
          state.tokensSent.length > 0,
      },
      {
        site: "jira.ts PATCH /connections/:id",
        setup: () =>
          created(
            call("post", `/api/jira/connections?projectId=${PROJ}`, {
              label: `jira-552-${next()}`,
              edition: "datacenter",
              baseUrl: "https://jira.coord.example.test",
              username: "svc",
              apiToken: "jira-token-552",
            }),
          ),
        send: (id) =>
          call("patch", `/api/jira/connections/${id}`, {
            baseUrl: "https://jira.moved.example.test",
          }),
        okStatus: 200,
        written: async (id) =>
          (await db.jiraConnection.findUniqueOrThrow({ where: { id } })).baseUrl ===
          "https://jira.moved.example.test",
      },
      {
        site: "test-management.ts PATCH /connections/:id",
        setup: () =>
          created(
            call("post", `/api/test-management/connections?projectId=${PROJ}`, {
              label: `tm-552-${next()}`,
              kind: "zephyr",
              baseUrl: "https://zephyr.coord.example.test",
              auth: { kind: "zephyr", bearerToken: "zephyr-token-552" },
            }),
          ),
        send: (id) =>
          call("patch", `/api/test-management/connections/${id}`, {
            baseUrl: "https://zephyr.moved.example.test",
          }),
        okStatus: 200,
        written: async (id) =>
          (await db.testManagementConnection.findUniqueOrThrow({ where: { id } })).baseUrl ===
          "https://zephyr.moved.example.test",
      },
    ];

    beforeAll(async () => {
      sqlite = createMigratedSqlite("552-binding-window-routes");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetVaultSingleton();
      setMCPRegistry(
        new MCPRegistryService(
          new MCPLifecycleManager({
            resolveEnv: async (e) => e,
            transportFactory: () => {
              throw new Error("no MCP transport in this test");
            },
          }),
        ),
      );
      for (const id of ["u-admin", "u-coord"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      await db.workspace.create({ data: { id: "ws-1", name: "ws-1", slug: "ws-1" } });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-1", userId: "u-coord", role: "member" },
      });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: "u-admin", workspaceId: "ws-1" },
      });
      // Not the project's first repo, so creating one does not start a real clone.
      await db.repoConnection.create({
        data: { projectId: PROJ, label: "existing-552", ownerOrOrg: "octo", repoName: "seed" },
      });
      await getVaultService().create(OWN_LABEL, OWN_VALUE, "global", { createdById: "u-coord" });
      COORD = issueTokens({
        userId: "u-coord",
        username: "u-coord",
        role: "coordinator",
        permissions: [],
        workspaces: ["ws-1"],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    beforeEach(() => {
      state.tokensSent.length = 0;
      state.onStamp = null;
    });

    afterAll(async () => {
      await vi.waitFor(() => expect(getAuditService().inFlight).toBe(0));
      setMCPRegistry(null);
      __resetVaultSingleton();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("covers every route-level call site", () => {
      expect(rows).toHaveLength(12);
    });

    it.each(rows.map((r) => [r.site, r] as const))(
      "%s — a write after the window closed is refused and writes nothing",
      async (_site, row) => {
        const fixture = await row.setup();
        const stamps: Date[] = [];
        let res: request.Response;
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
        // The check passes and stamps; then time reaches its `until` before the write.
        state.onStamp = (until) => {
          stamps.push(until);
          vi.setSystemTime(until.getTime());
        };
        try {
          res = await row.send(fixture);
        } finally {
          state.onStamp = null;
          vi.useRealTimers();
        }
        // The binding check ran and stamped the caller's own secret (the
        // connection's token, for jira / test-management): the refusal below
        // is the window, not the ownership rule.
        expect(stamps.length).toBeGreaterThan(0);
        expect(
          await db.secret.count({
            where: { createdById: "u-coord", bindingWriteUntil: stamps[stamps.length - 1] },
          }),
        ).toBeGreaterThan(0);
        if (row.expired) {
          row.expired(res);
        } else {
          expect(res.status, JSON.stringify(res.body)).toBe(409);
          expect(res.body.error.code).toBe(SECRET_BINDING_WINDOW_EXPIRED);
        }
        expect(await row.written(fixture, res)).toBe(false);
        expect(state.tokensSent).toEqual([]);
      },
    );

    it.each(rows.map((r) => [r.site, r] as const))(
      "%s — the same write inside its window lands (the fixture can write)",
      async (_site, row) => {
        const fixture = await row.setup();
        const stamps: Date[] = [];
        state.onStamp = (until) => stamps.push(until);
        const res = await row.send(fixture);
        expect(stamps.length).toBeGreaterThan(0);
        expectOk(res, row.okStatus);
        expect(await row.written(fixture, res)).toBe(true);
      },
    );

    // #552 x #574 — the window check runs inside the create's try, so a refusal
    // that comes AFTER the request auto-vaulted a plaintext secret still
    // withdraws it: the row never landed, so nothing will ever name it.
    it("mcp.ts POST / — a window refusal after auto-vaulting withdraws the vaulted secret", async () => {
      const label = `mcp-552-autovault-${next()}`;
      const vault = getVaultService();
      const realCreate = vault.create.bind(vault);
      let until: Date | null = null;
      const vaulted: string[] = [];
      state.onStamp = (u) => {
        until = u;
      };
      // The seam: each auto-vault really lands, THEN the clock reaches `until`.
      const spy = vi
        .spyOn(vault, "create")
        .mockImplementation(async (...args: Parameters<typeof vault.create>) => {
          const summary = await realCreate(...args);
          vaulted.push(summary.id);
          if (until) vi.setSystemTime(until.getTime());
          return summary;
        });
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      let res: request.Response;
      try {
        res = await call("post", "/api/mcp", {
          scope: "global",
          label,
          transport: "stdio",
          command: "node",
          args: ["server.js"],
          // A bound ref (so the check stamps) plus a plaintext secret (auto-vaulted).
          env: { API_KEY: ref(OWN_LABEL), UPSTREAM_TOKEN: "plaintext-autovault-value-552" },
        });
      } finally {
        spy.mockRestore();
        state.onStamp = null;
        vi.useRealTimers();
      }
      expect(until).not.toBeNull();
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe(SECRET_BINDING_WINDOW_EXPIRED);
      expect(await db.mCPServer.count({ where: { label } })).toBe(0);
      // The request did auto-vault the plaintext: the refusal came after it.
      expect(vaulted).toHaveLength(1);
      const secret = await db.secret.findUniqueOrThrow({ where: { id: vaulted[0] } });
      // ...and withdrew it, because the row never landed.
      expect(secret.deletedAt).not.toBeNull();
    });
  },
);
