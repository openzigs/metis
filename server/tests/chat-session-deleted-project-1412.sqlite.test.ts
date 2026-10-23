/**
 * #1412 / #1297 — a chat session in a SOFT-DELETED project, on every REST
 * path that loads a session, through the real routers with real access tokens
 * against a real SQLite database built by the migration chain.
 *
 * Owner decision (#1412, 2026-10-23): such a session is closed to non-admins
 * on every path — open, read, send, resume, fork, compact, approvals, skills,
 * plan, model — with exactly the 404 of a session that does not exist, and it
 * leaves their session lists; an admin keeps full access. The rule lives in
 * `loadAuthorizedSession` (`assertLiveProjectAccess`) and, for the lists, in
 * `reachableSessionWhere`.
 *
 * Each path is driven for a workspace project and a legacy workspace-less one
 * (open to every signed-in user while live), as a non-admin member and as an
 * admin, with a live project's session as the control that proves a path is
 * not refused for some other reason.
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
import type { AIProvider, ChatChunk, EmbedResult } from "../src/lib/ai/types.js";

const state = vi.hoisted(() => {
  // The route limiters read their caps at module load.
  process.env.AI_RATE_LIMIT_MAX = "100000";
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/rag/knowledge-service.js", async (original) => ({
  ...(await original<typeof import("../src/lib/rag/knowledge-service.js")>()),
  getKnowledgeService: () => ({ search: async () => ({ hits: [] }) }),
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole, type RoleKey } from "@metis/shared";

const { aiRouter, setAIProviderForTests } = await import("../src/routes/ai.js");
const { aiConversationRouter } = await import("../src/routes/ai-conversation.js");
const { aiSdkRouter } = await import("../src/routes/ai-sdk.js");
const { skillsRouter } = await import("../src/routes/skills.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { deleteProject } = await import("../src/lib/projects/project-service.js");
const { loadAuthorizedSession, SESSION_NOT_FOUND } =
  await import("../src/lib/ai/conversation/session-access.js");

/** A model that answers every turn, so an admin's send runs to completion. */
class StubProvider implements AIProvider {
  readonly key = "offline-stub" as const;
  readonly model = "stub-model";
  readonly offline = true;
  async chat() {
    return {
      content: "ok",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      model: "stub-model",
      provider: this.key,
    };
  }
  async *stream(): AsyncGenerator<ChatChunk> {
    yield { type: "delta", content: "ok" };
    yield { type: "done", finishReason: "stop" };
  }
  async embed(): Promise<EmbedResult> {
    return { vectors: [], dimension: 0, model: "stub" };
  }
  async models() {
    return ["stub-model"];
  }
  async ping() {
    return true;
  }
}

type Who = "mem" | "adm";
type Where = "ws" | "legacy" | "live";

/** One REST path that loads a session. `sid` is the session it names. */
interface SessionPath {
  name: string;
  method: "get" | "post" | "patch";
  url: (sid: string) => string;
  body?: (sid: string) => object;
}

const PATHS: SessionPath[] = [
  { name: "open (GET /sessions/:id)", method: "get", url: (s) => `/api/ai/sessions/${s}` },
  {
    name: "rename (PATCH /sessions/:id)",
    method: "patch",
    url: (s) => `/api/ai/sessions/${s}`,
    body: () => ({ title: "renamed" }),
  },
  { name: "usage", method: "get", url: (s) => `/api/ai/sessions/${s}/usage` },
  { name: "approval audit", method: "get", url: (s) => `/api/ai/sessions/${s}/approvals` },
  {
    name: "pending approvals",
    method: "get",
    url: (s) => `/api/ai/sessions/${s}/approvals/pending`,
  },
  {
    name: "answer an approval",
    method: "post",
    url: (s) => `/api/ai/sessions/${s}/approvals/appr-1`,
    body: () => ({ decision: "approve" }),
  },
  { name: "subagent run", method: "get", url: (s) => `/api/ai/sessions/${s}/subagent-runs/r1` },
  { name: "loaded skills", method: "get", url: (s) => `/api/ai/sessions/${s}/skills` },
  {
    name: "load a skill (session route)",
    method: "post",
    url: (s) => `/api/ai/sessions/${s}/skills`,
    body: () => ({ skillId: "no-such-skill" }),
  },
  {
    name: "load a skill (/api/skills/:id/load)",
    method: "post",
    url: () => `/api/skills/no-such-skill/load`,
    body: (s) => ({ sessionId: s }),
  },
  { name: "transcript (read)", method: "get", url: (s) => `/api/ai/sessions/${s}/messages` },
  { name: "resume", method: "post", url: (s) => `/api/ai/sessions/${s}/resume` },
  {
    name: "fork",
    method: "post",
    url: (s) => `/api/ai/sessions/${s}/fork`,
    body: () => ({ fromOrdinal: 1 }),
  },
  { name: "compact", method: "post", url: (s) => `/api/ai/sessions/${s}/compact` },
  {
    name: "switch model",
    method: "patch",
    url: (s) => `/api/ai/sessions/${s}/model`,
    body: () => ({ model: "stub-model" }),
  },
  { name: "read plan", method: "get", url: (s) => `/api/ai/sessions/${s}/plan` },
  {
    name: "record plan",
    method: "post",
    url: (s) => `/api/ai/sessions/${s}/plan`,
    body: () => ({ planText: "a plan" }),
  },
  {
    name: "decide plan",
    method: "post",
    url: (s) => `/api/ai/sessions/${s}/approve-plan`,
    body: () => ({ decision: "approve" }),
  },
  {
    name: "send (async /messages)",
    method: "post",
    url: (s) => `/api/ai/sessions/${s}/messages`,
    body: () => ({ content: "hello" }),
  },
  {
    name: "send (POST /chat)",
    method: "post",
    url: () => `/api/ai/chat`,
    body: (s) => ({ sessionId: s, message: "hello" }),
  },
  {
    name: "send (POST /stream)",
    method: "post",
    url: () => `/api/ai/stream`,
    body: (s) => ({ sessionId: s, message: "hello" }),
  },
];

const UNKNOWN = "no-such-session-1412";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1412 a chat session in a soft-deleted project — every session path, real SQLite",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const token: Partial<Record<Who, string>> = {};
    const sid: Record<Who, Partial<Record<Where, string>>> = { mem: {}, adm: {} };

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/ai", aiRouter());
      a.use("/api/ai", aiConversationRouter());
      a.use("/api/ai", aiSdkRouter());
      a.use("/api/skills", skillsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (who: Who, path: SessionPath, sessionId: string) => {
      const req = request(app())
        [path.method](path.url(sessionId))
        .set("Authorization", `Bearer ${token[who]}`);
      return path.body ? req.send(path.body(sessionId)) : req;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1412-chat-session-deleted-project");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      setAIProviderForTests(new StubProvider());

      for (const id of ["uMem", "uAdm"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@x.test` },
        });
      }
      await db.workspace.create({ data: { id: "wsA", name: "wsA", slug: "wsA" } });
      await db.workspaceMember.create({ data: { workspaceId: "wsA", userId: "uMem" } });
      const project = (id: string, workspaceId?: string) =>
        db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: "uMem",
            ...(workspaceId ? { workspaceId } : {}),
          },
        });
      await project("pWs", "wsA");
      await project("pLegacy"); // workspace-less: open to every signed-in user while live
      await project("pLive", "wsA");

      const mk = (userId: string, role: RoleKey, workspaces: string[]) =>
        issueTokens({
          userId,
          username: userId,
          role,
          permissions: getPermissionsForRole(role),
          workspaces,
        }).accessToken;
      token.mem = mk("uMem", "developer", ["wsA"]);
      token.adm = mk("uAdm", "admin", []);

      // Sessions are created through the real route, while every project is live.
      const create = async (who: Who, projectId: string): Promise<string> => {
        const res = await request(app())
          .post("/api/ai/sessions")
          .set("Authorization", `Bearer ${token[who]}`)
          .send({ projectId });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.data.session.projectId).toBe(projectId);
        return res.body.data.session.id as string;
      };
      for (const who of ["mem", "adm"] as const) {
        sid[who].ws = await create(who, "pWs");
        sid[who].legacy = await create(who, "pLegacy");
        sid[who].live = await create(who, "pLive");
      }
      // Inside the resume window, so `?status=resumable` lists them too.
      await db.aISession.updateMany({ data: { snapshotUpdatedAt: new Date() } });

      // The project service's own soft delete: the sessions remain.
      const admin = { id: "uAdm", role: "admin" } as Parameters<typeof deleteProject>[1];
      await deleteProject("pWs", admin);
      await deleteProject("pLegacy", admin);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setAIProviderForTests(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("the fixture: both projects are soft-deleted and every session row remains", async () => {
      const gone = await db.project.findMany({
        where: { deletedAt: { not: null } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      expect(gone.map((p) => p.id)).toEqual(["pLegacy", "pWs"]);
      expect(await db.aISession.count({ where: { projectId: { in: ["pWs", "pLegacy"] } } })).toBe(
        4,
      );
    });

    describe("a non-admin: every path answers the 404 of an unknown session", () => {
      it.each(PATHS)("$name", async (path) => {
        const unknown = await call("mem", path, UNKNOWN);
        expect(unknown.status).toBe(404);
        expect(unknown.body.error?.code).toBe(SESSION_NOT_FOUND);
        for (const where of ["ws", "legacy"] as const) {
          const res = await call("mem", path, sid.mem[where]!);
          expect(res.status, `${where}: ${JSON.stringify(res.body)}`).toBe(404);
          expect(res.body, where).toEqual(unknown.body);
        }
        // The control: the same path on a live project's session is not refused.
        const live = await call("mem", path, sid.mem.live!);
        expect(live.body?.error?.code, JSON.stringify(live.body)).not.toBe(SESSION_NOT_FOUND);
      });
    });

    describe("an admin: every path still reaches their session", () => {
      it.each(PATHS)("$name", async (path) => {
        const unknown = await call("adm", path, UNKNOWN);
        expect(unknown.body.error?.code).toBe(SESSION_NOT_FOUND);
        for (const where of ["ws", "legacy"] as const) {
          const res = await call("adm", path, sid.adm[where]!);
          expect(res.body?.error?.code, `${where}: ${JSON.stringify(res.body)}`).not.toBe(
            SESSION_NOT_FOUND,
          );
        }
      });

      it("opens, reads and takes a turn in it", async () => {
        const open = await call("adm", PATHS[0], sid.adm.ws!);
        expect(open.status).toBe(200);
        const stream = PATHS.find((p) => p.name === "send (POST /stream)")!;
        const sent = await call("adm", stream, sid.adm.ws!);
        expect(sent.status).toBe(200);
        expect(sent.text).toContain("event: done");
        const read = await call(
          "adm",
          PATHS.find((p) => p.name === "transcript (read)")!,
          sid.adm.ws!,
        );
        expect(read.status).toBe(200);
        expect(read.body.data.messages.length).toBeGreaterThanOrEqual(2);
      });
    });

    it("a non-admin's turn in it never reaches the model or the transcript", async () => {
      const stream = PATHS.find((p) => p.name === "send (POST /stream)")!;
      const before = await db.aIMessage.count({ where: { sessionId: sid.mem.ws! } });
      const res = await call("mem", stream, sid.mem.ws!);
      expect(res.status).toBe(404);
      expect(await db.aIMessage.count({ where: { sessionId: sid.mem.ws! } })).toBe(before);
    });

    describe("the session lists", () => {
      const listed = async (who: Who, query = ""): Promise<string[]> => {
        const res = await request(app())
          .get(`/api/ai/sessions${query}`)
          .set("Authorization", `Bearer ${token[who]}`);
        expect(res.status).toBe(200);
        return (res.body.data as Array<{ id: string }>).map((s) => s.id).sort();
      };

      it.each(["", "?status=resumable"])(
        "a non-admin's list%s leaves a deleted project's sessions out",
        async (query) => {
          expect(await listed("mem", query)).toEqual([sid.mem.live!]);
        },
      );

      it.each(["", "?status=resumable"])("an admin's list%s still has them", async (query) => {
        expect(await listed("adm", query)).toEqual(
          [sid.adm.ws!, sid.adm.legacy!, sid.adm.live!].sort(),
        );
      });
    });

    it("loadAuthorizedSession itself: one 404 for a deleted project, an admin passes", async () => {
      const mem = { userId: "uMem", username: "uMem", role: "developer", workspaces: ["wsA"] };
      for (const where of ["ws", "legacy"] as const) {
        await expect(loadAuthorizedSession(mem as never, sid.mem[where]!)).rejects.toMatchObject({
          statusCode: 404,
          code: SESSION_NOT_FOUND,
        });
      }
      await expect(loadAuthorizedSession(mem as never, sid.mem.live!)).resolves.toMatchObject({
        id: sid.mem.live,
      });
      const adm = { userId: "uAdm", username: "uAdm", role: "admin", workspaces: [] };
      await expect(loadAuthorizedSession(adm as never, sid.adm.ws!)).resolves.toMatchObject({
        id: sid.adm.ws,
      });
    });
  },
);
