/**
 * #1251 — follow-ups to #1232's widening of impact-analysis access to members.
 *
 * 1. A `job:{id}` room is re-judged when its access can be lost, so a member
 *    removed from the workspace stops receiving a run's events WITHOUT
 *    reconnecting: on member removal (the real `DELETE
 *    /api/workspaces/:id/members/:memberId` route), on a project soft-delete
 *    or workspace delete (`evictProjectRoom` / `evictWorkspaceProjectRooms`),
 *    and in the re-validation pass for a removal whose eviction was lost.
 * 2. The usage-override DELETE is open to any `analysis.run` member of the
 *    project, not only the override's author (the decided rule), and closed
 *    to a reader-role member.
 * 3. Impact rerun and Jira publish refuse a reader-role member with 403.
 *
 * Real SQLite built by the migration chain, real routers, services, JWTs, the
 * real job-room rule (`resolveJobRoomScope` → `loadAccessibleImpactDetail`)
 * and the real eviction module and re-validation pass. The socket transport is
 * an in-process fake (rooms are sets; an emit lands in each member's inbox).
 * Nobody here is a system admin — an admin bypasses every check.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  getPermissionsForRole,
  jobRoom,
  userRoom,
  type AuthPayload,
  type RoleKey,
} from "@metis/shared";
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

const { impactAnalysisRouter } = await import("../src/routes/impact-analysis.js");
const { workspacesRouter } = await import("../src/routes/workspaces.js");
const { resolveJobRoomScope } = await import("../src/lib/socket/room-access.js");
const { createJobEventEmitter, _resetJobLifecycleMemory } =
  await import("../src/lib/socket/job-events.js");
const { evictProjectRoom, evictWorkspaceProjectRooms } =
  await import("../src/lib/socket/project-room-eviction.js");
const { registerSocketServer } = await import("../src/lib/socket/registry.js");
const { revalidateLocalSockets } = await import("../src/lib/socket/server.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
type MetisIOServer = import("../src/lib/socket/server.js").MetisIOServer;

// ── The in-process transport ────────────────────────────────────────────────
interface FakeSocket {
  id: string;
  data: { user: AuthPayload };
  rooms: Set<string>;
  inbox: Array<{ event: string; payload: unknown }>;
  nsp: { server: MetisIOServer };
  conn: { close: ReturnType<typeof vi.fn> };
  disconnect: ReturnType<typeof vi.fn>;
  join(room: string): Promise<void>;
  leave(room: string): Promise<void>;
  emit(event: string, payload: unknown): boolean;
}
const sockets = new Map<string, FakeSocket>();
const inRoom = (room: string) => [...sockets.values()].filter((s) => s.rooms.has(room));
const leaveAll = (members: FakeSocket[], rooms: string | string[]) => {
  for (const s of members) for (const r of [rooms].flat()) s.rooms.delete(r);
};
const broadcast = {
  in: (room: string) => ({
    socketsLeave: (rooms: string | string[]) => leaveAll(inRoom(room), rooms),
  }),
  socketsLeave: (rooms: string | string[]) => leaveAll([...sockets.values()], rooms),
};
const io = {
  ...broadcast,
  local: broadcast,
  of: () => ({ sockets }),
  to: (room: string) => ({
    emit: (event: string, payload: unknown) => {
      for (const s of inRoom(room)) s.inbox.push({ event, payload });
    },
  }),
} as unknown as MetisIOServer;

const WS1 = "ws1-1251";
const WS2 = "ws2-1251";
const PA = "proj-a-1251";
const PB = "proj-b-1251";
const PC = "proj-c-1251";

/** Olga owns ws1. Rob, Tess and Sam are coordinator members; Rita is a reader. */
const USERS: Record<string, { role: RoleKey; ws: string; wsRole: string }> = {
  olga: { role: "coordinator", ws: WS1, wsRole: "owner" },
  rob: { role: "coordinator", ws: WS1, wsRole: "member" },
  tess: { role: "coordinator", ws: WS1, wsRole: "member" },
  sam: { role: "coordinator", ws: WS1, wsRole: "member" },
  rita: { role: "reader", ws: WS1, wsRole: "member" },
  mallory: { role: "coordinator", ws: WS2, wsRole: "owner" },
};
type Who = keyof typeof USERS;

const payload = (who: Who): AuthPayload => ({
  userId: who,
  username: who,
  role: USERS[who].role,
  permissions: getPermissionsForRole(USERS[who].role),
  workspaces: [USERS[who].ws],
});
const bearer = (who: Who) => `Bearer ${issueTokens(payload(who)).accessToken}`;

let seq = 0;
function connect(who: Who) {
  const id = `sock-${who}-${++seq}`;
  const s: FakeSocket = {
    id,
    data: { user: payload(who) },
    rooms: new Set([id, userRoom(who)]),
    inbox: [],
    nsp: { server: io },
    conn: { close: vi.fn() },
    disconnect: vi.fn(),
    join: async (room) => void s.rooms.add(room),
    leave: async (room) => void s.rooms.delete(room),
    emit: (event, p) => {
      s.inbox.push({ event: `local:${event}`, payload: p });
      return true;
    },
  };
  sockets.set(id, s);
  return {
    /** `subscribe:job`'s rule, then the join — as the server's handler does. */
    subscribeJob: async (jobId: string) => {
      const scope = await resolveJobRoomScope(s.data.user, jobId);
      expect(scope, `${who} may join job:${jobId}`).not.toBeNull();
      await s.join(jobRoom(jobId));
    },
    inJob: (jobId: string) => s.rooms.has(jobRoom(jobId)),
    events: (jobId: string) =>
      s.inbox
        .filter((e) => e.event === "job:lifecycle")
        .map((e) => e.payload as { jobId: string })
        .filter((e) => e.jobId === jobId),
    closed: () => s.conn.close.mock.calls.length,
  };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1251 — job rooms re-judged on member removal; the override-delete rule; reader 403s",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const memberRow: Partial<Record<Who, string>> = {};
    const impact: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };
    let analysisA = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/impact-analyses", impactAnalysisRouter());
      a.use("/api/workspaces", workspacesRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1251-job-room-eviction");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      registerSocketServer(io);
      for (const key of ["coordinator", "reader"]) {
        await db.role.create({ data: { id: `role-${key}`, key, name: key } });
      }
      for (const [id, u] of Object.entries(USERS)) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.userRole.create({ data: { userId: id, roleId: `role-${u.role}` } });
      }
      for (const ws of [WS1, WS2]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [userId, u] of Object.entries(USERS)) {
        const row = await db.workspaceMember.create({
          data: { workspaceId: u.ws, userId, role: u.wsRole },
        });
        memberRow[userId as Who] = row.id;
      }
      for (const [id, workspaceId] of [
        [PA, WS1],
        [PB, WS1],
        [PC, WS1],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "olga", workspaceId, status: "active" },
        });
      }
      // One completed impact analysis over each project, all started by Olga.
      for (const [key, projectId] of [
        ["a", PA],
        ["b", PB],
        ["c", PC],
      ] as const) {
        const ia = await db.impactAnalysis.create({
          data: { status: "completed", startedById: "olga", sourceText: `change ${key}` },
        });
        await db.impactAnalysisProject.create({ data: { analysisId: ia.id, projectId } });
        impact[key] = ia.id;
      }
      // A project-scoped job too: an analysis of project A.
      analysisA = (await db.analysis.create({ data: { projectId: PA, startedById: "olga" } })).id;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      registerSocketServer(null as unknown as MetisIOServer);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      sockets.clear();
      _resetJobLifecycleMemory();
    });

    // ── 1. Job rooms ─────────────────────────────────────────────────────────

    describe("job rooms (`job:{id}`)", () => {
      it("a member removed through the route leaves the impact run's room and the analysis's without reconnecting; a teammate stays", async () => {
        const rob = connect("rob");
        const tess = connect("tess");
        for (const member of [rob, tess]) {
          await member.subscribeJob(impact.a);
          await member.subscribeJob(analysisA);
        }

        const res = await request(app())
          .delete(`/api/workspaces/${WS1}/members/${memberRow.rob}`)
          .set("Authorization", bearer("olga"));
        expect(res.status).toBe(200);

        expect(rob.inJob(impact.a)).toBe(false);
        expect(rob.inJob(analysisA)).toBe(false);
        expect(rob.closed()).toBe(0); // left the rooms; the transport was not dropped
        expect(tess.inJob(impact.a)).toBe(true);
        expect(tess.inJob(analysisA)).toBe(true);

        const emitter = createJobEventEmitter(io);
        emitter.progress("impact-analysis", impact.a, null, 50, "Scoring");
        emitter.progress("analysis", analysisA, PA, 20, "Analysing");
        expect(rob.events(impact.a)).toEqual([]);
        expect(rob.events(analysisA)).toEqual([]);
        expect(tess.events(impact.a)).toHaveLength(1);
        expect(tess.events(analysisA)).toHaveLength(1);
      });

      it("the re-validation pass applies a removal whose eviction never ran", async () => {
        const sam = connect("sam");
        const tess = connect("tess");
        await sam.subscribeJob(impact.a);
        await tess.subscribeJob(impact.a);

        // Removed behind the eviction's back (a relay another replica lost).
        await db.workspaceMember.delete({ where: { id: memberRow.sam } });
        await revalidateLocalSockets(io, "sweep");

        expect(sam.inJob(impact.a)).toBe(false);
        expect(tess.inJob(impact.a)).toBe(true);
      });

      it("a soft-deleted project's impact run room is re-judged; runs over other projects are untouched", async () => {
        const tess = connect("tess");
        await tess.subscribeJob(impact.b);
        await tess.subscribeJob(impact.a);

        await db.project.update({ where: { id: PB }, data: { deletedAt: new Date() } });
        try {
          await evictProjectRoom(PB);
          expect(tess.inJob(impact.b)).toBe(false);
          expect(tess.inJob(impact.a)).toBe(true);
        } finally {
          await db.project.update({ where: { id: PB }, data: { deletedAt: null } });
        }
      });

      it("a deleted workspace's impact run rooms are re-judged", async () => {
        const tess = connect("tess");
        await tess.subscribeJob(impact.c);

        await db.workspace.update({ where: { id: WS1 }, data: { deletedAt: new Date() } });
        try {
          await evictWorkspaceProjectRooms(WS1);
          expect(tess.inJob(impact.c)).toBe(false);
        } finally {
          await db.workspace.update({ where: { id: WS1 }, data: { deletedAt: null } });
        }
      });
    });

    // ── 2. The usage-override delete rule ────────────────────────────────────

    describe("usage-override DELETE", () => {
      const createOverride = async (tableName: string) =>
        (
          await db.schemaUsageOverride.create({
            data: {
              projectId: PA,
              kind: "table",
              tableName,
              usageClass: "used",
              createdBy: "olga",
            },
          })
        ).id;
      const del = (who: Who, id: string) =>
        request(app())
          .delete(`/api/impact-analyses/projects/${PA}/usage-overrides/${id}`)
          .set("Authorization", bearer(who));

      it("any analysis.run member of the project deletes a teammate's override, not only its author", async () => {
        const id = await createOverride("public.teammate_1251");
        expect((await del("tess", id)).status).toBe(204);
        expect(await db.schemaUsageOverride.findUnique({ where: { id } })).toBeNull();
      });

      it("a reader-role member and a non-member are refused, and the override survives", async () => {
        const id = await createOverride("public.kept_1251");
        expect((await del("rita", id)).status).toBe(403);
        expect((await del("mallory", id)).status).toBe(403);
        expect(await db.schemaUsageOverride.findUnique({ where: { id } })).not.toBeNull();
      });
    });

    // ── 3. Reader-role 403s ──────────────────────────────────────────────────

    describe("reader-role member", () => {
      const post = (who: Who, path: string) =>
        request(app()).post(path).set("Authorization", bearer(who)).send({});

      it("is refused an impact rerun with 403, though the run is open to read", async () => {
        expect(
          (
            await request(app())
              .get(`/api/impact-analyses/${impact.a}`)
              .set("Authorization", bearer("rita"))
          ).status,
        ).toBe(200);
        const res = await post("rita", `/api/impact-analyses/${impact.a}/rerun`);
        expect(res.status).toBe(403);
        expect(await db.impactAnalysis.count({ where: { rerunOfId: impact.a } })).toBe(0);
      });

      it("is refused a Jira publish with 403, where a coordinator member gets past the gate", async () => {
        const path = `/api/impact-analyses/${impact.a}/publish/jira`;
        expect((await post("rita", path)).status).toBe(403);
        // Tess clears the permission and access gates and stops on configuration.
        const tess = await post("tess", path);
        expect(tess.status).toBe(400);
      });
    });
  },
);
