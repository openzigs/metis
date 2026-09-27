/**
 * #305 — routes and session paths that acted on a project without the caller's
 * project-access check, proven through the REAL routers against a REAL SQLite
 * database built from the migration chain.
 *
 * Two workspaces: `ws-a` (project `proj-a-0001`) and `ws-b` (project `proj-b-0001`). The
 * attacker is `u-b`, a coordinator in `ws-b` — a role that holds `mcp.manage`,
 * `project.update`, `review.admin` and `analysis.read`, so every refusal below
 * is the project check, never the role check. Each refusal asserts the 404 AND
 * that nothing was read back or written (the "write reports success while the
 * read cannot see it" shape, inverted: a refusal must leave the store exactly
 * as it was). In-workspace callers and system admins are positive controls so a
 * check that refuses everyone cannot pass.
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
  process.env.AI_RATE_LIMIT_MAX = "10000";
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
// The catalog installs resolve an entry before creating a server. Serve one
// installable entry from each, so an unguarded install WOULD create a row —
// otherwise a 404 "entry not found" would pass the refusal tests vacuously.
vi.mock("../src/lib/mcp/registry-client.js", async (original) => ({
  ...(await original<typeof import("../src/lib/mcp/registry-client.js")>()),
  fetchRegistry: vi.fn(async () => ({
    servers: [
      {
        id: "any",
        name: "registry-entry",
        install: { type: "http", url: "https://example.test/mcp" },
      },
    ],
  })),
}));
vi.mock("../src/lib/mcp/federation/registry-cache.js", async (original) => ({
  ...(await original<typeof import("../src/lib/mcp/federation/registry-cache.js")>()),
  getEntryById: vi.fn(async () => ({
    id: "any",
    source: "official",
    externalId: "ext-any",
    name: "federated-entry",
    manifest: { type: "http", url: "https://example.test/mcp" },
  })),
  recordLocalInstall: vi.fn(async () => undefined),
}));

const { mcpRouter } = await import("../src/routes/mcp.js");
const { reviewsRouter } = await import("../src/routes/reviews.js");
const { runsRouter } = await import("../src/routes/runs.js");
const { customAgentsRouter } = await import("../src/routes/custom-agents.js");
const { aiRouter } = await import("../src/routes/ai.js");
const { aiSdkRouter } = await import("../src/routes/ai-sdk.js");
const { skillsRouter } = await import("../src/routes/skills.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");
const { __resetAIRateLimiter } = await import("../src/middleware/ai-rate-limit.js");

type Role = "admin" | "coordinator" | "developer" | "reader";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#305 — project-scoped routes and session paths check the caller's project access",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const token = (userId: string, role: Role, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
    let ADMIN = "";
    let A = ""; // coordinator in ws-a
    let B = ""; // coordinator in ws-b — the attacker
    let READER_A = ""; // reader in ws-a — the wrong-role caller

    const app = () => {
      const a = express();
      a.set("trust proxy", 1);
      a.use(express.json());
      a.use("/api/mcp", mcpRouter());
      a.use("/api/reviews", reviewsRouter());
      a.use("/api/runs", runsRouter());
      a.use("/api/custom-agents", customAgentsRouter());
      a.use("/api/ai", aiRouter());
      a.use("/api/ai", aiSdkRouter());
      a.use("/api/skills", skillsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    let ip = 0;
    const call = (
      method: "get" | "post" | "put" | "patch",
      url: string,
      bearer?: string,
      body?: Record<string, unknown>,
    ) => {
      ip += 1;
      const r = request(app())
        [method](url)
        .set("X-Forwarded-For", `203.0.113.${ip % 250}`);
      if (bearer) r.set("Authorization", `Bearer ${bearer}`);
      return body ? r.send(body) : r;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("305-project-access");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
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

      for (const id of ["u-admin", "u-a", "u-b", "u-reader-a"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of ["ws-a", "ws-b"]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.create({
        data: { workspaceId: "ws-a", userId: "u-a", role: "owner" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-b", userId: "u-b", role: "owner" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-a", userId: "u-reader-a", role: "member" },
      });
      for (const [id, ws] of [
        ["proj-a-0001", "ws-a"],
        ["proj-b-0001", "ws-b"],
      ]) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-admin", workspaceId: ws },
        });
      }
      // A global MCP server on p-a's allow-list, and a project server of p-a.
      await db.mCPServer.create({
        data: { id: "mcp-g", scope: "global", label: "g", transport: "http", url: "https://x" },
      });
      await db.mCPServer.create({
        data: {
          id: "mcp-pa",
          scope: "project",
          projectId: "proj-a-0001",
          label: "pa",
          transport: "http",
          url: "https://x",
        },
      });
      await db.projectMCPAllowlist.create({
        data: { projectId: "proj-a-0001", mcpServerId: "mcp-g" },
      });
      // A review in p-a.
      await db.reviewRequest.create({
        data: { id: "rv-a", projectId: "proj-a-0001", title: "A review", requestedById: "u-a" },
      });
      // A replay run in p-a.
      await db.agentRun.create({
        data: { id: "run-a", sessionId: "chat-a", projectId: "proj-a-0001" },
      });
      // A custom agent owned by p-a.
      await db.customAgent.create({
        data: { id: "ca-a", projectId: "proj-a-0001", name: "agent-a" },
      });
      // u-b still OWNS a chat bound to p-a (they have since lost that project),
      // and a project-less one.
      const snapshotUpdatedAt = new Date();
      await db.aISession.create({
        data: {
          id: "s-b-in-a",
          userId: "u-b",
          projectId: "proj-a-0001",
          provider: "anthropic",
          model: "m",
          snapshotUpdatedAt,
        },
      });
      await db.aISession.create({
        data: {
          id: "s-b-free",
          userId: "u-b",
          provider: "anthropic",
          model: "m",
          snapshotUpdatedAt,
        },
      });
      // A vault secret created by u-a.
      await db.secret.create({
        data: {
          id: "sec-a",
          name: "global:a-key",
          ciphertext: "x",
          iv: "x",
          tag: "x",
          salt: "x",
          createdById: "u-a",
        },
      });

      ADMIN = token("u-admin", "admin", []);
      A = token("u-a", "coordinator", ["ws-a"]);
      B = token("u-b", "coordinator", ["ws-b"]);
      READER_A = token("u-reader-a", "reader", ["ws-a"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setMCPRegistry(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const mcpRows = () => db.mCPServer.count();
    const allowlistOf = async (projectId: string) =>
      (await db.projectMCPAllowlist.findMany({ where: { projectId } })).map((r) => r.mcpServerId);

    // ── /api/mcp ──────────────────────────────────────────────────────────
    describe("/api/mcp", () => {
      it("GET /projects/:projectId/allowlist — 404 cross-workspace, 401 anonymous, 200 in reach", async () => {
        const cross = await call("get", "/api/mcp/projects/proj-a-0001/allowlist", B);
        expect(cross.status).toBe(404);
        expect(cross.body.data).toBeUndefined();
        expect((await call("get", "/api/mcp/projects/proj-a-0001/allowlist")).status).toBe(401);
        const own = await call("get", "/api/mcp/projects/proj-a-0001/allowlist", READER_A);
        expect(own.status).toBe(200);
        expect(own.body.data.items).toEqual(["mcp-g"]);
        expect((await call("get", "/api/mcp/projects/proj-a-0001/allowlist", ADMIN)).status).toBe(
          200,
        );
      });

      it("PUT /projects/:projectId/allowlist — 404 cross-workspace and the allow-list is untouched", async () => {
        const res = await call("put", "/api/mcp/projects/proj-a-0001/allowlist", B, {
          serverIds: [],
        });
        expect(res.status).toBe(404);
        expect(await allowlistOf("proj-a-0001")).toEqual(["mcp-g"]);
        // Wrong role in the right workspace: 403 from the permission layer.
        const reader = await call("put", "/api/mcp/projects/proj-a-0001/allowlist", READER_A, {
          serverIds: [],
        });
        expect(reader.status).toBe(403);
        expect(await allowlistOf("proj-a-0001")).toEqual(["mcp-g"]);
      });

      it("PUT /projects/:projectId/allowlist — the project's own coordinator can still set it", async () => {
        const res = await call("put", "/api/mcp/projects/proj-a-0001/allowlist", A, {
          serverIds: ["mcp-g"],
        });
        expect(res.status).toBe(200);
        expect(await allowlistOf("proj-a-0001")).toEqual(["mcp-g"]);
      });

      it("GET /projects/:projectId/available — 404 cross-workspace, lists in reach", async () => {
        const cross = await call("get", "/api/mcp/projects/proj-a-0001/available", B);
        expect(cross.status).toBe(404);
        const own = await call("get", "/api/mcp/projects/proj-a-0001/available", A);
        expect(own.status).toBe(200);
        expect(own.body.data.items.map((s: { id: string }) => s.id).sort()).toEqual([
          "mcp-g",
          "mcp-pa",
        ]);
      });

      it("GET /?projectId= — 404 cross-workspace, filters in reach", async () => {
        expect((await call("get", "/api/mcp?projectId=proj-a-0001", B)).status).toBe(404);
        const own = await call("get", "/api/mcp?projectId=proj-a-0001", A);
        expect(own.status).toBe(200);
        expect(own.body.data.items.map((s: { id: string }) => s.id)).toEqual(["mcp-pa"]);
      });

      it("POST / scope=project — 404 cross-workspace, no server and no vaulted secret created", async () => {
        const [servers, secrets] = [await mcpRows(), await db.secret.count()];
        const res = await call("post", "/api/mcp", B, {
          label: "evil",
          transport: "http",
          url: "https://example.test/mcp",
          scope: "project",
          projectId: "proj-a-0001",
          headers: { Authorization: "Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789" },
        });
        expect(res.status).toBe(404);
        expect(await mcpRows()).toBe(servers);
        expect(await db.secret.count()).toBe(secrets);
      });

      it.each([
        ["/api/mcp/import", { mcpJson: { mcpServers: { x: { url: "https://example.test" } } } }],
        [
          "/api/mcp/import-copilot",
          { mcpJson: { servers: { x: { type: "http", url: "https://example.test" } } } },
        ],
        ["/api/mcp/registry/install", { registryServerId: "any" }],
        ["/api/mcp/federation/install", { entryId: "any" }],
      ])("POST %s scope=project — 404 cross-workspace, nothing created", async (url, body) => {
        const before = await mcpRows();
        const res = await call("post", url, B, {
          ...body,
          scope: "project",
          projectId: "proj-a-0001",
        });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
        expect(await mcpRows()).toBe(before);
      });

      it("POST /import dry-run scope=project — the project's own coordinator is not refused", async () => {
        const res = await call("post", "/api/mcp/import", A, {
          mcpJson: { mcpServers: { x: { url: "https://example.test" } } },
          dryRun: true,
          scope: "project",
          projectId: "proj-a-0001",
        });
        expect(res.status).toBe(200);
        expect(res.body.data.dryRun).toBe(true);
      });
    });

    // ── /api/reviews ──────────────────────────────────────────────────────
    describe("/api/reviews", () => {
      const ids = (res: request.Response) =>
        (res.body.data.reviews as Array<{ id: string }>).map((r) => r.id);

      it("GET /?projectId= — 404 cross-workspace", async () => {
        expect((await call("get", "/api/reviews?projectId=proj-a-0001", B)).status).toBe(404);
        const own = await call("get", "/api/reviews?projectId=proj-a-0001", A);
        expect(own.status).toBe(200);
        expect(ids(own)).toEqual(["rv-a"]);
      });

      it("GET / unfiltered — lists only the caller's projects' reviews", async () => {
        const cross = await call("get", "/api/reviews", B);
        expect(cross.status).toBe(200);
        expect(ids(cross)).not.toContain("rv-a");
        expect(cross.body.data.total).toBe(0);
        expect(ids(await call("get", "/api/reviews", A))).toEqual(["rv-a"]);
        expect(ids(await call("get", "/api/reviews", ADMIN))).toEqual(["rv-a"]);
      });

      it("GET /:reviewId — 404 cross-workspace, 401 anonymous, 200 in reach", async () => {
        const cross = await call("get", "/api/reviews/rv-a", B);
        expect(cross.status).toBe(404);
        expect(cross.body.error.code).toBe("REVIEW_NOT_FOUND");
        expect((await call("get", "/api/reviews/rv-a")).status).toBe(401);
        expect((await call("get", "/api/reviews/rv-a", READER_A)).status).toBe(200);
      });

      it.each(["submit", "withdraw", "close"])(
        "POST /:reviewId/%s — a cross-workspace review.admin gets 404 and the review is unchanged",
        async (action) => {
          const res = await call("post", `/api/reviews/rv-a/${action}`, B, {});
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe("REVIEW_NOT_FOUND");
          const row = await db.reviewRequest.findUnique({ where: { id: "rv-a" } });
          expect(row?.status).toBe("draft");
        },
      );

      it("POST /:reviewId/decision — 404 cross-workspace; a reader is refused by role", async () => {
        const body = { decision: "approved" };
        expect((await call("post", "/api/reviews/rv-a/decision", B, body)).status).toBe(404);
        expect((await call("post", "/api/reviews/rv-a/decision", READER_A, body)).status).toBe(403);
      });
    });

    // ── /api/runs ─────────────────────────────────────────────────────────
    describe("/api/runs", () => {
      const ids = (res: request.Response) =>
        (res.body.data.items as Array<{ id: string }>).map((r) => r.id);

      it("GET /?projectId= — 404 cross-workspace", async () => {
        expect((await call("get", "/api/runs?projectId=proj-a-0001", B)).status).toBe(404);
        expect(ids(await call("get", "/api/runs?projectId=proj-a-0001", A))).toEqual(["run-a"]);
      });

      it("GET /?sessionId= and unfiltered — another workspace's runs never appear", async () => {
        const bySession = await call("get", "/api/runs?sessionId=chat-a", B);
        expect(bySession.status).toBe(200);
        expect(ids(bySession)).toEqual([]);
        expect(ids(await call("get", "/api/runs", B))).toEqual([]);
        expect(ids(await call("get", "/api/runs?sessionId=chat-a", A))).toEqual(["run-a"]);
        expect(ids(await call("get", "/api/runs", ADMIN))).toEqual(["run-a"]);
        expect((await call("get", "/api/runs")).status).toBe(401);
      });
    });

    // ── /api/custom-agents/:id/enablement ─────────────────────────────────
    describe("PUT /api/custom-agents/:id/enablement", () => {
      it("a foreign agent cannot be enabled in the caller's own project: 404, no row", async () => {
        const res = await call("put", "/api/custom-agents/ca-a/enablement", B, {
          projectId: "proj-b-0001",
          enabled: true,
        });
        expect(res.status).toBe(404);
        expect(
          await db.customAgentEnablement.count({
            where: { customAgentId: "ca-a", projectId: "proj-b-0001" },
          }),
        ).toBe(0);
      });

      it("the agent's own workspace admin can still enable it", async () => {
        const res = await call("put", "/api/custom-agents/ca-a/enablement", A, {
          projectId: "proj-a-0001",
          enabled: true,
        });
        expect(res.status).toBe(200);
        expect(
          await db.customAgentEnablement.count({
            where: { customAgentId: "ca-a", projectId: "proj-a-0001" },
          }),
        ).toBe(1);
      });
    });

    // ── project-bound session paths ───────────────────────────────────────
    describe("sessions the caller owns in a project they can no longer reach", () => {
      it("PATCH /api/ai/sessions/:id/model — 404, model unchanged", async () => {
        const res = await call("patch", "/api/ai/sessions/s-b-in-a/model", B, { model: "other" });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("AI_SESSION_NOT_FOUND");
        const row = await db.aISession.findUnique({ where: { id: "s-b-in-a" } });
        expect(row?.currentModel).toBeNull();
      });

      it("GET/POST /plan and POST /approve-plan — 404, no plan written", async () => {
        expect((await call("get", "/api/ai/sessions/s-b-in-a/plan", B)).status).toBe(404);
        expect(
          (await call("post", "/api/ai/sessions/s-b-in-a/plan", B, { planText: "do it" })).status,
        ).toBe(404);
        expect(
          (
            await call("post", "/api/ai/sessions/s-b-in-a/approve-plan", B, {
              decision: "approved",
            })
          ).status,
        ).toBe(404);
        expect(await db.sessionPlan.count({ where: { sessionId: "s-b-in-a" } })).toBe(0);
      });

      it("POST /messages — 404, no background run bound to the project", async () => {
        const res = await call("post", "/api/ai/sessions/s-b-in-a/messages", B, {
          content: "hello",
        });
        expect(res.status).toBe(404);
        expect(await db.backgroundRun.count({ where: { projectId: "proj-a-0001" } })).toBe(0);
      });

      it("GET/POST /api/ai/sessions/:id/skills and POST /api/skills/:id/load — 404", async () => {
        expect((await call("get", "/api/ai/sessions/s-b-in-a/skills", B)).status).toBe(404);
        expect(
          (await call("post", "/api/ai/sessions/s-b-in-a/skills", B, { skillKey: "any" })).status,
        ).toBe(404);
        expect(
          (await call("post", "/api/skills/any/load", B, { sessionId: "s-b-in-a" })).status,
        ).toBe(404);
        // The project-less chat is still the owner's.
        expect((await call("get", "/api/ai/sessions/s-b-free/skills", B)).status).toBe(200);
      });

      it("GET /api/ai/sessions?status=resumable — omits the unreachable project's session", async () => {
        const res = await call("get", "/api/ai/sessions?status=resumable", B);
        expect(res.status).toBe(200);
        expect((res.body.data as Array<{ id: string }>).map((s) => s.id)).toEqual(["s-b-free"]);
      });
    });

    // ── providerSecretRef ─────────────────────────────────────────────────
    describe("POST /api/ai/sessions providerSecretRef", () => {
      it("another user's vault secret: 404 SECRET_NOT_FOUND and no session", async () => {
        const before = await db.aISession.count();
        const res = await call("post", "/api/ai/sessions", B, { providerSecretRef: "sec-a" });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("SECRET_NOT_FOUND");
        expect(await db.aISession.count()).toBe(before);
      });

      it("an unknown secret id: the same 404", async () => {
        const res = await call("post", "/api/ai/sessions", B, { providerSecretRef: "nope" });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("SECRET_NOT_FOUND");
      });

      it("anonymous: 401", async () => {
        __resetAIRateLimiter();
        expect(
          (await call("post", "/api/ai/sessions", undefined, { providerSecretRef: "sec-a" }))
            .status,
        ).toBe(401);
      });

      it("the secret's creator, and a system admin, may reference it", async () => {
        const own = await call("post", "/api/ai/sessions", A, { providerSecretRef: "sec-a" });
        expect(own.status).toBe(201);
        expect(own.body.data.session.providerSecretRef).toBe("sec-a");
        const admin = await call("post", "/api/ai/sessions", ADMIN, { providerSecretRef: "sec-a" });
        expect(admin.status).toBe(201);
      });
    });
  },
);
