/**
 * #1290 — the join-only rooms that carry project data are re-judged when
 * access can be lost, as `project:{id}` (#1212) and `job:{id}` (#1251) are:
 *
 *   `analysis:{id}`, `session:{id}`, `connector:{id}`, `run:{id}`,
 *   `task:{id}` and `publish:{batchId}` (#1297), `thread:{id}` (joined by `subscribe:thread` and by `presence:thread:join`)
 *   and `presence:{type}:{id}` (a discussion and a Spec Kit artifact).
 *
 * For each kind: a member removed through the real `DELETE
 * /api/workspaces/:id/members/:memberId` route stops receiving the room's
 * events without reconnecting, while a teammate keeps receiving them; a
 * project soft-delete and a workspace delete close the room to non-admins
 * (and only them); and the re-validation pass applies a removal whose
 * eviction never ran. Presence lists drop the evicted viewer too.
 *
 * Real SQLite built by the migration chain, the real workspaces router, the
 * real join rules and handlers (the thread and presence handlers are wired
 * onto the fake socket; the analysis, session, connector and run handlers live
 * inside `server.ts`'s connection handler, so their rule is run and the room
 * joined, as that handler does), and the real eviction module and
 * re-validation pass. The transport is an in-process fake: rooms are sets and
 * an emit lands in each member's inbox. Nobody but `ada` is a system admin.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import {
  analysisRoom,
  bgRunRoom,
  connectorRoom,
  getPermissionsForRole,
  presenceRoom,
  publishRoom,
  sessionRoom,
  taskRoom,
  threadRoom,
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

const { workspacesRouter } = await import("../src/routes/workspaces.js");
const { canJoinAnalysisRoom } = await import("../src/lib/socket/analysis-room-access.js");
const {
  canJoinBgRunRoom,
  canJoinConnectorRoom,
  canJoinPublishRoom,
  canJoinSessionRoom,
  canJoinTaskRoom,
} = await import("../src/lib/socket/room-access.js");
const { wireThreadRoomHandlers } = await import("../src/lib/socket/discussion-rooms.js");
const { createThreadPresence, wireDiscussionPresenceHandlers } =
  await import("../src/lib/socket/discussion-presence.js");
const { wirePresenceHandlers, getRoomPresence, clearPresenceState } =
  await import("../src/lib/collaboration/presence.js");
const { evictProjectRoom, evictWorkspaceProjectRooms } =
  await import("../src/lib/socket/project-room-eviction.js");
const { _resetRoomProjects } = await import("../src/lib/socket/room-scope.js");
const { setJoinRateLimiter, JoinRateLimiter } =
  await import("../src/lib/socket/join-rate-limit.js");
const { registerSocketServer } = await import("../src/lib/socket/registry.js");
const { bumpEpoch } = await import("../src/lib/socket/revocation-relay.js");
const { revalidateLocalSockets } = await import("../src/lib/socket/server.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
type MetisIOServer = import("../src/lib/socket/server.js").MetisIOServer;
type ThreadPresence = import("../src/lib/socket/discussion-presence.js").ThreadPresence;

// ── The in-process transport ────────────────────────────────────────────────
interface FakeSocket {
  id: string;
  // #1414 — a socket also carries its token's session; no expiry here.
  data: { user: AuthPayload; session: { sid: undefined; exp: undefined } };
  rooms: Set<string>;
  inbox: Array<{ event: string; payload: unknown }>;
  handlers: Map<string, (...args: unknown[]) => unknown>;
  nsp: { server: MetisIOServer };
  conn: { close: ReturnType<typeof vi.fn> };
  disconnect: ReturnType<typeof vi.fn>;
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  join(room: string): Promise<void>;
  leave(room: string): Promise<void>;
  emit(event: string, payload: unknown): boolean;
  to(room: string): {
    emit: (e: string, p: unknown) => void;
    local: { emit: (e: string, p: unknown) => void };
  };
}
const sockets = new Map<string, FakeSocket>();
const inRoom = (room: string) => [...sockets.values()].filter((s) => s.rooms.has(room));
const deliver = (members: FakeSocket[], event: string, payload: unknown) => {
  for (const s of members) s.inbox.push({ event, payload });
};
const leaveAll = (members: FakeSocket[], rooms: string | string[]) => {
  for (const s of members) for (const r of [rooms].flat()) s.rooms.delete(r);
};
const roomEmitter = (room: string) => ({
  emit: (event: string, payload: unknown) => deliver(inRoom(room), event, payload),
});
const broadcast = {
  in: (room: string) => ({
    socketsLeave: (rooms: string | string[]) => leaveAll(inRoom(room), rooms),
  }),
  socketsLeave: (rooms: string | string[]) => leaveAll([...sockets.values()], rooms),
  to: roomEmitter,
};
const connectionListeners: Array<(socket: FakeSocket) => void> = [];
const io = {
  ...broadcast,
  local: broadcast,
  of: () => ({ sockets }),
  on: (event: string, listener: (socket: FakeSocket) => void) => {
    if (event === "connection") connectionListeners.push(listener);
  },
} as unknown as MetisIOServer;

const WS1 = "ws1-1290";
const WS2 = "ws2-1290";
const PA = "proj-a-1290";
const PB = "proj-b-1290";
const PL = "proj-legacy-1290"; // predates workspaces: open to any authenticated user

/** Olga owns ws1; Rob and Tess are coordinator members; Ada is a system admin member. */
const USERS: Record<string, { role: RoleKey; ws: string; wsRole: string }> = {
  olga: { role: "coordinator", ws: WS1, wsRole: "owner" },
  rob: { role: "coordinator", ws: WS1, wsRole: "member" },
  tess: { role: "coordinator", ws: WS1, wsRole: "member" },
  ada: { role: "admin", ws: WS1, wsRole: "member" },
  mallory: { role: "coordinator", ws: WS2, wsRole: "owner" },
};
type Who = keyof typeof USERS;

/** The handshake's snapshot — it still names ws1 after a removal. */
const payload = (who: Who): AuthPayload => ({
  userId: who,
  username: who,
  role: USERS[who].role,
  permissions: getPermissionsForRole(USERS[who].role),
  workspaces: [USERS[who].ws],
});
const bearer = (who: Who) => `Bearer ${issueTokens(payload(who)).accessToken}`;

// ── Fixtures, per project ───────────────────────────────────────────────────
interface ProjectFixtures {
  analysis: string;
  connector: string;
  run: string;
  thread: string;
  /** #1297 — a scheduled task and a publish batch in the project. */
  task: string;
  batch: string;
  /** Each user's own chat session in the project (a session is its owner's alone). */
  session: Record<Who, string>;
}
const fx: Record<string, ProjectFixtures> = {};
/** A session bound to no project. */
let unscopedSession = "";

let threadPresence: ThreadPresence;
let seq = 0;

function connect(who: Who) {
  const id = `sock-${who}-${++seq}`;
  const s: FakeSocket = {
    id,
    data: { user: payload(who), session: { sid: undefined, exp: undefined } },
    rooms: new Set([id, userRoom(who)]),
    inbox: [],
    handlers: new Map(),
    nsp: { server: io },
    conn: { close: vi.fn() },
    disconnect: vi.fn(),
    on: (event, handler) => void s.handlers.set(event, handler),
    join: async (room) => void s.rooms.add(room),
    leave: async (room) => void s.rooms.delete(room),
    emit: (event, p) => {
      s.inbox.push({ event: `local:${event}`, payload: p });
      return true;
    },
    to: (room) => {
      const others = () => inRoom(room).filter((o) => o !== s);
      const send = (event: string, p: unknown) => deliver(others(), event, p);
      return { emit: send, local: { emit: send } };
    },
  };
  sockets.set(id, s);
  wireThreadRoomHandlers(s as never);
  wireDiscussionPresenceHandlers(s as never, { presence: threadPresence });
  for (const listener of connectionListeners) listener(s);
  const call = async (event: string, body: unknown) => {
    await s.handlers.get(event)!(body);
  };
  /** A server.ts handler: its rule, then the join — as `attachHandlers` does. */
  const viaRule = async (room: string, allowed: Promise<boolean>) => {
    expect(await allowed, `${who} may join ${room}`).toBe(true);
    await s.join(room);
  };
  return {
    socket: s,
    who,
    closed: () => s.conn.close.mock.calls.length,
    in: (room: string) => s.rooms.has(room),
    received: (event: string) => s.inbox.filter((e) => e.event === event).length,
    viaRule,
    call,
  };
}
type Client = ReturnType<typeof connect>;

/** One room kind: the room a user is in for project `p`, and how they join it. */
interface Kind {
  name: string;
  room(who: Who, p: string): string;
  join(c: Client, p: string): Promise<void>;
  /** Send the join through the real handler, asserting nothing (handler kinds only). */
  send?(c: Client, p: string): Promise<void>;
}
/** A kind joined through a handler wired onto the fake socket. */
const viaHandler = (
  name: string,
  room: (p: string) => string,
  event: string,
  body: (p: string) => unknown,
): Kind => ({
  name,
  room: (_w, p) => room(p),
  send: (c, p) => c.call(event, body(p)),
  join: async (c, p) => {
    await c.call(event, body(p));
    expect(c.in(room(p)), `${c.who} joined ${room(p)}`).toBe(true);
  },
});

const KINDS: Kind[] = [
  {
    name: "analysis:{id}",
    room: (_w, p) => analysisRoom(fx[p].analysis),
    join: (c, p) =>
      c.viaRule(analysisRoom(fx[p].analysis), canJoinAnalysisRoom(payload(c.who), fx[p].analysis)),
  },
  {
    name: "session:{id}",
    room: (w, p) => sessionRoom(fx[p].session[w]),
    join: (c, p) =>
      c.viaRule(
        sessionRoom(fx[p].session[c.who]),
        canJoinSessionRoom(payload(c.who), fx[p].session[c.who]),
      ),
  },
  {
    name: "connector:{id}",
    room: (_w, p) => connectorRoom(fx[p].connector),
    join: (c, p) =>
      c.viaRule(
        connectorRoom(fx[p].connector),
        canJoinConnectorRoom(payload(c.who), fx[p].connector),
      ),
  },
  {
    name: "run:{id}",
    room: (_w, p) => bgRunRoom(fx[p].run),
    join: (c, p) => c.viaRule(bgRunRoom(fx[p].run), canJoinBgRunRoom(payload(c.who), fx[p].run)),
  },
  // #1297 — joined on the role alone until then.
  {
    name: "task:{id}",
    room: (_w, p) => taskRoom(fx[p].task),
    join: (c, p) => c.viaRule(taskRoom(fx[p].task), canJoinTaskRoom(payload(c.who), fx[p].task)),
  },
  {
    name: "publish:{batchId}",
    room: (_w, p) => publishRoom(fx[p].batch),
    join: (c, p) =>
      c.viaRule(publishRoom(fx[p].batch), canJoinPublishRoom(payload(c.who), fx[p].batch)),
  },
  viaHandler(
    "thread:{id} (subscribe:thread)",
    (p) => threadRoom(fx[p].thread),
    "subscribe:thread",
    (p) => ({ threadId: fx[p].thread }),
  ),
  viaHandler(
    "thread:{id} (presence:thread:join)",
    (p) => threadRoom(fx[p].thread),
    "presence:thread:join",
    (p) => ({ threadId: fx[p].thread }),
  ),
  viaHandler(
    "presence:discussion:{id}",
    (p) => presenceRoom("discussion", fx[p].thread),
    "presence:join",
    (p) => ({ artifactType: "discussion", artifactId: fx[p].thread }),
  ),
  viaHandler(
    "presence:spec-kit-artifact:{project}:{name}",
    (p) => presenceRoom("spec-kit-artifact", `${p}:spec.md`),
    "presence:join",
    (p) => ({ artifactType: "spec-kit-artifact", artifactId: `${p}:spec.md` }),
  ),
];

const PROBE = "probe:1290";
const probe = (room: string) => roomEmitter(room).emit(PROBE, { room });

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1290 — project-data rooms re-judged on member removal, project and workspace delete",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const memberRow: Partial<Record<Who, string>> = {};

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/workspaces", workspacesRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    const removeMember = async (who: Who) => {
      const res = await request(app())
        .delete(`/api/workspaces/${WS1}/members/${memberRow[who]}`)
        .set("Authorization", bearer("olga"));
      expect(res.status).toBe(200);
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1290-project-data-rooms");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      registerSocketServer(io);
      threadPresence = createThreadPresence(io, false);
      wirePresenceHandlers(io);
      for (const key of ["coordinator", "admin"]) {
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
      for (const [id, workspaceId] of [
        [PA, WS1],
        [PB, WS1],
        [PL, null],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "olga", workspaceId, status: "active" },
        });
        const session = {} as Record<Who, string>;
        for (const who of Object.keys(USERS) as Who[]) {
          session[who] = (
            await db.aISession.create({
              data: { userId: who, projectId: id, provider: "offline", model: "m" },
            })
          ).id;
        }
        fx[id] = {
          analysis: (await db.analysis.create({ data: { projectId: id, startedById: "olga" } })).id,
          connector: (await db.repoConnection.create({ data: { projectId: id, label: "repo" } }))
            .id,
          run: (await db.backgroundRun.create({ data: { projectId: id, kind: "analysis" } })).id,
          task: (await db.task.create({ data: { projectId: id, type: "analysis" } })).id,
          batch: (
            await db.publishBatch.create({
              data: { projectId: id, targetOwner: "o", targetRepo: "r", startedById: "olga" },
            })
          ).id,
          thread: (
            await db.discussionThread.create({ data: { projectId: id, createdById: "olga" } })
          ).id,
          session,
        };
      }
      unscopedSession = (
        await db.aISession.create({ data: { userId: "tess", provider: "offline", model: "m" } })
      ).id;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      registerSocketServer(null as unknown as MetisIOServer);
      setJoinRateLimiter();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      sockets.clear();
      clearPresenceState();
      threadPresence.members.clear();
      _resetRoomProjects();
      // A generous limiter: a scenario joins many rooms on one socket at once.
      setJoinRateLimiter(
        new JoinRateLimiter({
          socket: { burst: 1000, perSecond: 1000 },
          user: { burst: 1000, perSecond: 1000 },
        }),
      );
      // Every member is (back) in ws1, and nothing is deleted.
      for (const [who, u] of Object.entries(USERS)) {
        const row = await db.workspaceMember.upsert({
          where: { workspaceId_userId: { workspaceId: u.ws, userId: who } },
          create: { workspaceId: u.ws, userId: who, role: u.wsRole },
          update: {},
        });
        memberRow[who as Who] = row.id;
      }
      await db.project.updateMany({ data: { deletedAt: null } });
      await db.workspace.updateMany({ data: { deletedAt: null } });
    });

    describe.each(KINDS)("$name", (kind) => {
      it("a member removed through the route stops receiving it without reconnecting; a teammate keeps receiving", async () => {
        const rob = connect("rob");
        const tess = connect("tess");
        await kind.join(rob, PA);
        await kind.join(tess, PA);

        await removeMember("rob");

        expect(rob.in(kind.room("rob", PA))).toBe(false);
        expect(rob.closed()).toBe(0); // left the room; the transport was not dropped
        expect(tess.in(kind.room("tess", PA))).toBe(true);
        expect(tess.closed()).toBe(0);
        // One probe per distinct room (a session room is its owner's own).
        for (const room of new Set([kind.room("rob", PA), kind.room("tess", PA)])) probe(room);
        expect(rob.received(PROBE)).toBe(0);
        expect(tess.received(PROBE)).toBe(1);
      });

      it("the re-validation pass applies a removal whose eviction never ran", async () => {
        const rob = connect("rob");
        const tess = connect("tess");
        await kind.join(rob, PA);
        await kind.join(tess, PA);

        // Removed behind the eviction's back (a relay another replica lost).
        await db.workspaceMember.delete({ where: { id: memberRow.rob } });
        await revalidateLocalSockets(io, "sweep");

        expect(rob.in(kind.room("rob", PA))).toBe(false);
        expect(tess.in(kind.room("tess", PA))).toBe(true);
      });

      it("a soft-deleted project closes it to non-admins only, and leaves another project's alone", async () => {
        const tess = connect("tess");
        const ada = connect("ada");
        await kind.join(tess, PA);
        await kind.join(tess, PB);
        await kind.join(ada, PA);

        await db.project.update({ where: { id: PA }, data: { deletedAt: new Date() } });
        await evictProjectRoom(PA);

        expect(tess.in(kind.room("tess", PA))).toBe(false);
        expect(tess.in(kind.room("tess", PB))).toBe(true);
        expect(ada.in(kind.room("ada", PA))).toBe(true);
        expect(tess.closed() + ada.closed()).toBe(0);
      });

      it("a soft-deleted project's room cannot be joined again by a member", async () => {
        await db.project.update({ where: { id: PA }, data: { deletedAt: new Date() } });
        const tess = connect("tess");
        await expect(kind.join(tess, PA)).rejects.toThrow();
        expect(tess.in(kind.room("tess", PA))).toBe(false);
      });

      it("a deleted workspace closes it to non-admins", async () => {
        const tess = connect("tess");
        const ada = connect("ada");
        await kind.join(tess, PB);
        await kind.join(ada, PB);

        await db.workspace.update({ where: { id: WS1 }, data: { deletedAt: new Date() } });
        await evictWorkspaceProjectRooms(WS1);

        expect(tess.in(kind.room("tess", PB))).toBe(false);
        expect(ada.in(kind.room("ada", PB))).toBe(true);
      });

      it("a user of another workspace stays in a legacy no-workspace project's room through each re-judgement", async () => {
        const mallory = connect("mallory");
        await kind.join(mallory, PL);
        await evictProjectRoom(PL);
        await revalidateLocalSockets(io, "sweep");
        expect(mallory.in(kind.room("mallory", PL))).toBe(true);
        expect(mallory.closed()).toBe(0);
      });
    });

    // The handlers wired onto the fake socket (thread, thread presence, artifact
    // presence) read the eviction epoch before their check. An eviction that
    // runs while the check is in flight cannot see the socket — it is not in
    // the room yet — so the handler judges the join again once it is.
    describe.each(KINDS.filter((k) => k.send))("join race: $name", (kind) => {
      it("a member removed while the join's check is in flight is judged again once in the room", async () => {
        const rob = connect("rob");
        // The check's last read is the project row (`assertProjectAccess`):
        // once it has answered, Rob is removed and an eviction runs, which
        // cannot see his socket because it is not in the room yet.
        const real = db.project.findUnique.bind(db.project);
        let raced = false;
        const spy = vi.spyOn(db.project, "findUnique").mockImplementation((async (
          args: Parameters<typeof real>[0],
        ) => {
          const row = await real(args);
          if (!raced) {
            raced = true;
            await db.workspaceMember.delete({ where: { id: memberRow.rob } });
            bumpEpoch(io, "eviction");
          }
          return row;
        }) as never);
        try {
          await kind.send!(rob, PA);
        } finally {
          spy.mockRestore();
        }
        expect(raced).toBe(true);
        expect(rob.in(kind.room("rob", PA))).toBe(false);
        probe(kind.room("rob", PA));
        expect(rob.received(PROBE)).toBe(0);
      });
    });

    describe("presence lists", () => {
      it("a removed member drops off the discussion and Spec Kit presence lists; the teammate stays listed", async () => {
        const rob = connect("rob");
        const tess = connect("tess");
        const discussion = presenceRoom("discussion", fx[PA].thread);
        const specKit = presenceRoom("spec-kit-artifact", `${PA}:spec.md`);
        for (const c of [rob, tess]) {
          await c.call("presence:join", { artifactType: "discussion", artifactId: fx[PA].thread });
          await c.call("presence:join", {
            artifactType: "spec-kit-artifact",
            artifactId: `${PA}:spec.md`,
          });
        }
        tess.socket.inbox.length = 0;

        await removeMember("rob");

        for (const room of [discussion, specKit]) {
          const listed = [...(getRoomPresence().get(room)?.values() ?? [])].map((m) => m.userId);
          expect(listed, room).toEqual(["tess"]);
        }
        // The remaining viewer is told the shorter list.
        const updates = tess.socket.inbox
          .filter((e) => e.event === "presence:update")
          .map((e) => e.payload as { room: string; users: Array<{ userId: string }> });
        expect(updates.find((u) => u.room === discussion)?.users.map((u) => u.userId)).toEqual([
          "tess",
        ]);
      });

      it("a removed member drops off a thread's presence list and can no longer type into it", async () => {
        const rob = connect("rob");
        const tess = connect("tess");
        const room = threadRoom(fx[PA].thread);
        await rob.call("presence:thread:join", { threadId: fx[PA].thread });
        await tess.call("presence:thread:join", { threadId: fx[PA].thread });

        await removeMember("rob");

        expect(
          [...(threadPresence.members.get(room)?.values() ?? [])].map((m) => m.userId),
        ).toEqual(["tess"]);
        await rob.call("typing:start", { threadId: fx[PA].thread });
        expect(tess.received("typing:update")).toBe(0);
      });
    });

    it("a chat session bound to no project stays open through a project and workspace delete", async () => {
      const tess = connect("tess");
      await tess.viaRule(
        sessionRoom(unscopedSession),
        canJoinSessionRoom(payload("tess"), unscopedSession),
      );
      await db.project.update({ where: { id: PA }, data: { deletedAt: new Date() } });
      await evictProjectRoom(PA);
      await removeMember("tess");
      await revalidateLocalSockets(io, "sweep");
      expect(tess.in(sessionRoom(unscopedSession))).toBe(true);
    });
  },
);
