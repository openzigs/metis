/**
 * Issue #1430 — a soft-deleted project is closed to non-admin members on the
 * whole `/api/projects/:projectId/**` subtree and on the guards that resolve a
 * project from a row (runs, requirements, baselines, Jira connections), through
 * the real `apiRouter()` with real access tokens against a real SQLite database
 * built by the migration chain.
 *
 * The rule (owner decision on #1412, already applied to chat sessions and the
 * runs lists): a soft-deleted project answers a non-admin exactly as an unknown
 * one does — the same status and the same body — while an admin keeps full
 * access, and a live project the member can reach is unaffected.
 *
 * One representative route per impact row of #1430, each probed with a request
 * the handler refuses or answers without side effects once the guard has let it
 * through (a body that fails validation, or a read), so the only thing that
 * differs between "guard admitted" and "guard refused" is the guard:
 *
 *   external writes   POST publishing/batches            (live publish to GitHub/Jira)
 *   customer systems  POST imports/preview               (reads the customer's tracker)
 *   LLM spend         POST spec-kit/constitution         (drafts with the project model)
 *   content reads     GET  documents/:documentId
 *   config writes     POST stakeholders
 *   the project       GET  /projects/:id                 (the base route)
 *
 * and one route behind each row-resolving helper: `authorizeRunProject`,
 * `requirement-authz`, `resource-project-access` and `connection-authz`.
 *
 * Every row runs for a workspace project and for a legacy (`workspaceId: null`)
 * one, which is open to any signed-in user while live.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});

import express from "express";
import request from "supertest";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";

const { errorHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { apiRouter } = await import("../src/routes/index.js");
const { deleteProject } = await import("../src/lib/projects/project-service.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");

type Kind = "ws" | "legacy";
type Who = "mem" | "adm";

/** The fixture ids per project kind: a live project and a soft-deleted one. */
const FIX = {
  ws: { live: "pLive", gone: "pGone" },
  legacy: { live: "pLegLive", gone: "pLegGone" },
} as const;

interface Row {
  impact: string;
  method: "get" | "post";
  /** The URL for a project id; `null` names an id that does not exist. */
  url: (projectId: string | null) => string;
  body?: Record<string, unknown>;
  /** What the guard-admitted handler answers for a live project. */
  live: number;
  /** What an admin is answered for the soft-deleted project; defaults to `live`. */
  adminGone?: number;
}

/** Row-resolving helpers address a row by id; the row id of each project. */
const rowId = (prefix: string) => (projectId: string | null) =>
  projectId === null ? `${prefix}-nope` : `${prefix}-${projectId}`;

const ROWS: Row[] = [
  {
    impact: "external writes — POST publishing/batches",
    method: "post",
    url: (p) => `/api/projects/${p ?? "no-such-project"}/publishing/batches`,
    body: {},
    live: 400,
  },
  {
    impact: "customer systems — POST imports/preview",
    method: "post",
    url: (p) => `/api/projects/${p ?? "no-such-project"}/imports/preview`,
    body: {},
    live: 400,
  },
  {
    impact: "LLM spend — POST spec-kit/constitution",
    method: "post",
    url: (p) => `/api/projects/${p ?? "no-such-project"}/spec-kit/constitution`,
    body: { projectOverrides: 42 },
    live: 400,
  },
  {
    impact: "content reads — GET documents/:documentId",
    method: "get",
    // An unknown project is asked for a document id that exists elsewhere.
    url: (p) => `/api/projects/${p ?? "no-such-project"}/documents/doc-${p ?? FIX.ws.live}`,
    live: 200,
  },
  {
    impact: "config writes — POST stakeholders",
    method: "post",
    url: (p) => `/api/projects/${p ?? "no-such-project"}/stakeholders`,
    body: {},
    live: 400,
  },
  {
    impact: "the project itself — GET /projects/:id",
    method: "get",
    url: (p) => `/api/projects/${p ?? "no-such-project"}`,
    live: 200,
    // Pre-existing and unchanged: the read itself filters `deletedAt` for everyone.
    adminGone: 404,
  },
  {
    impact: "authorizeRunProject — GET runs/background?projectId=",
    method: "get",
    url: (p) => `/api/runs/background?projectId=${p ?? "no-such-project"}`,
    live: 200,
  },
  {
    impact: "requirement-authz — GET requirements/:id/assignments",
    method: "get",
    url: (p) => `/api/requirements/${rowId("req")(p)}/assignments`,
    live: 200,
  },
  {
    impact: "resource-project-access — GET baselines/:id",
    method: "get",
    url: (p) => `/api/baselines/${rowId("bl")(p)}`,
    live: 200,
  },
  {
    impact: "connection-authz — GET jira/connections/:id",
    method: "get",
    url: (p) => `/api/jira/connections/${rowId("jc")(p)}`,
    live: 200,
  },
];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1430 a soft-deleted project's subtree — non-admin 404 like unknown, admin open, real SQLite",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const token: Record<Who, string> = { mem: "", adm: "" };
    let app: express.Express;

    const send = (row: Row, projectId: string | null, who: Who) => {
      const req = request(app)
        [row.method](row.url(projectId))
        .set("Authorization", `Bearer ${token[who]}`);
      return row.body ? req.send(row.body) : req;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1430-deleted-project-subtree");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      // The MCP list routes read through the registry; no server is started.
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

      for (const id of ["uMem", "uAdm"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
      }
      await db.workspace.create({ data: { id: "wsD", name: "wsD", slug: "wsD" } });
      await db.workspaceMember.create({ data: { workspaceId: "wsD", userId: "uMem" } });
      // Another workspace's live project: its 404 is the one a deleted project must match too.
      await db.workspace.create({ data: { id: "wsF", name: "wsF", slug: "wsF" } });

      await db.secret.create({
        data: {
          id: "sec-jira",
          name: "jira-token",
          ciphertext: "x",
          iv: "x",
          tag: "x",
          salt: "x",
        },
      });

      const all = [
        { id: FIX.ws.live, workspaceId: "wsD" },
        { id: FIX.ws.gone, workspaceId: "wsD" },
        { id: FIX.legacy.live, workspaceId: null },
        { id: FIX.legacy.gone, workspaceId: null },
        { id: "pForeign", workspaceId: "wsF" },
      ];
      for (const { id, workspaceId } of all) {
        await db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: "uMem",
            ...(workspaceId ? { workspaceId } : {}),
          },
        });
        await db.analysis.create({
          data: { id: `an-${id}`, projectId: id, startedById: "uMem" },
        });
        await db.requirement.create({
          data: {
            id: `req-${id}`,
            projectId: id,
            analysisId: `an-${id}`,
            title: "r",
            body: "b",
          },
        });
        await db.document.create({
          data: {
            id: `doc-${id}`,
            projectId: id,
            filename: "brief.md",
            mimeType: "text/markdown",
            sizeBytes: 1,
            storagePath: `/tmp/1430/${id}`,
            checksum: id,
            uploadedById: "uMem",
          },
        });
        await db.baseline.create({
          data: { id: `bl-${id}`, projectId: id, name: `bl-${id}`, createdById: "uMem" },
        });
        await db.jiraConnection.create({
          data: {
            id: `jc-${id}`,
            projectId: id,
            label: `jc-${id}`,
            edition: "cloud",
            baseUrl: "https://jira.example.test",
            username: "u",
            secretId: "sec-jira",
            createdById: "uMem",
          },
        });
        await db.reviewRequest.create({
          data: { id: `rr-${id}`, projectId: id, title: `rr-${id}`, requestedById: "uMem" },
        });
        await db.mCPServer.create({
          data: {
            id: `mcp-${id}`,
            label: `mcp-${id}`,
            transport: "http",
            url: "https://mcp.example.test",
            scope: "project",
            projectId: id,
          },
        });
      }

      // The project service's own soft delete: every row hanging off it stays.
      const admin = { id: "uAdm", role: "admin" } as Parameters<typeof deleteProject>[1];
      await deleteProject(FIX.ws.gone, admin);
      await deleteProject(FIX.legacy.gone, admin);

      const mk = (userId: string, role: RoleKey, workspaces: string[]) =>
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: getPermissionsForRole(role),
          workspaces,
        }).accessToken;
      // A coordinator holds every permission the rows need, so a refusal is the guard's.
      token.mem = mk("uMem", "coordinator", ["wsD"]);
      token.adm = mk("uAdm", "admin", []);

      app = express();
      app.use(express.json());
      app.use("/api", apiRouter());
      app.use(errorHandler);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setMCPRegistry(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the fixture's deleted projects are soft-deleted, with their rows still present", async () => {
      const gone = await db.project.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      expect(gone.map((p) => p.id)).toEqual([FIX.ws.gone, FIX.legacy.gone].sort());
      expect(await db.baseline.count({ where: { projectId: FIX.ws.gone } })).toBe(1);
      expect(await db.jiraConnection.count({ where: { projectId: FIX.legacy.gone } })).toBe(1);
    });

    for (const row of ROWS) {
      describe(row.impact, () => {
        for (const kind of ["ws", "legacy"] as Kind[]) {
          const { live, gone } = FIX[kind];

          it(`${kind}: a non-admin member is answered 404, byte-identical to an unknown id`, async () => {
            const unknown = await send(row, null, "mem");
            expect(unknown.status).toBe(404);
            // Another workspace's live project answers that same 404.
            const foreign = await send(row, "pForeign", "mem");
            expect(foreign.status).toBe(404);
            expect(foreign.body).toEqual(unknown.body);

            const res = await send(row, gone, "mem");
            expect(res.status).toBe(404);
            expect(res.body).toEqual(unknown.body);
          });

          it(`${kind}: a live project the member reaches is still answered (${row.live})`, async () => {
            const res = await send(row, live, "mem");
            expect(res.status).toBe(row.live);
          });

          it(`${kind}: an admin keeps access to the soft-deleted project`, async () => {
            const res = await send(row, gone, "adm");
            expect(res.status).toBe(row.adminGone ?? row.live);
          });
        }
      });
    }

    // The unfiltered lists narrow with `workspaceScopeWhere`: a member must not
    // be listed a row that answers 404 when opened. Admins still see it.
    describe("unfiltered lists leave a soft-deleted project's rows out for a member", () => {
      const listed = async (path: string, who: Who, pick: (body: unknown) => string[]) => {
        const res = await request(app).get(path).set("Authorization", `Bearer ${token[who]}`);
        expect(res.status).toBe(200);
        return pick(res.body);
      };
      const reviewIds = (b: unknown) =>
        (b as { data: { reviews: Array<{ id: string }> } }).data.reviews.map((r) => r.id).sort();
      const mcpIds = (b: unknown) =>
        (b as { data: { items: Array<{ id: string }> } }).data.items.map((s) => s.id).sort();
      // The export is keyed by the server's label, which is its id here.
      const exportIds = (b: unknown) =>
        (JSON.stringify(b).match(/mcp-p[A-Za-z]+/g) ?? [])
          .filter((v, i, a) => a.indexOf(v) === i)
          .sort();

      it("GET /api/reviews", async () => {
        expect(await listed("/api/reviews", "mem", reviewIds)).toEqual(
          [`rr-${FIX.legacy.live}`, `rr-${FIX.ws.live}`].sort(),
        );
        expect(await listed("/api/reviews", "adm", reviewIds)).toEqual(
          expect.arrayContaining([`rr-${FIX.ws.gone}`, `rr-${FIX.legacy.gone}`]),
        );
      });

      it("GET /api/mcp", async () => {
        expect(await listed("/api/mcp", "mem", mcpIds)).toEqual(
          [`mcp-${FIX.legacy.live}`, `mcp-${FIX.ws.live}`].sort(),
        );
        expect(await listed("/api/mcp", "adm", mcpIds)).toEqual(
          expect.arrayContaining([`mcp-${FIX.ws.gone}`, `mcp-${FIX.legacy.gone}`]),
        );
      });

      it("GET /api/mcp/export", async () => {
        expect(await listed("/api/mcp/export", "mem", exportIds)).toEqual(
          [`mcp-${FIX.legacy.live}`, `mcp-${FIX.ws.live}`].sort(),
        );
        expect(await listed("/api/mcp/export", "adm", exportIds)).toEqual(
          expect.arrayContaining([`mcp-${FIX.ws.gone}`, `mcp-${FIX.legacy.gone}`]),
        );
      });
    });
  },
);
