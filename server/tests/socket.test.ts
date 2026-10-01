/**
 * Socket.IO server: handshake auth + room subscription smoke test.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

/**
 * #255 — `subscribe:project` now authorizes the user against their accessible
 * projects via `actorCanAccessProject` → `prisma.project.findMany`. The mock
 * grants the developer `u1` access to project `p1` only (they "created" it), so
 * cross-project isolation can be asserted: `p1` joins, `p-other` is rejected.
 * Admins bypass the DB check entirely.
 */
/**
 * #617 — the handshake re-reads the user and the durable role. Every user is
 * live unless listed in `accounts`; `u-admin` holds a durable admin role,
 * everyone else developer unless `roles` says otherwise.
 */
const authDb = vi.hoisted(() => ({
  accounts: new Map<string, { username: string; status: string; deletedAt: Date | null }>(),
  roles: new Map<string, string>(),
  lookupError: null as Error | null,
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: {
      upsert: vi.fn(),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; status?: string; deletedAt?: null } }) => {
          if (authDb.lookupError) throw authDb.lookupError;
          const row = authDb.accounts.get(where.id) ?? {
            username: `db-${where.id}`,
            status: "active",
            deletedAt: null,
          };
          if (where.status !== undefined && row.status !== where.status) return null;
          if (where.deletedAt === null && row.deletedAt !== null) return null;
          return { id: where.id, username: row.username, authRoleAuthority: null };
        },
      ),
    },
    userRole: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) => [
        {
          source: "local",
          role: {
            key:
              authDb.roles.get(where.userId) ??
              (where.userId === "u-admin" ? "admin" : "developer"),
          },
        },
      ]),
    },
    // #645 — `u1` is a live member of workspace `w1`; nobody else is in one.
    workspaceMember: {
      findMany: vi.fn(async (args?: { where?: { userId?: string } }) =>
        args?.where?.userId === "u1" ? [{ workspaceId: "w1" }] : [],
      ),
    },
    // #645 — `subscribe:analysis` authorizes like the REST read: `a1` belongs
    // to `p1` in workspace `w1`; `a-deleted` is soft-deleted; nothing else exists.
    analysis: {
      findFirst: vi.fn(async (args?: { where?: { id?: string; deletedAt?: null } }) => {
        if (args?.where?.id === "a-boom") throw new Error("db down");
        if (args?.where?.id === "a1") return { id: "a1", projectId: "p1", deletedAt: null };
        // Review of #652 — resolves late, so an unsubscribe can land first.
        if (args?.where?.id === "a-slow") {
          await new Promise((r) => setTimeout(r, 50));
          return { id: "a-slow", projectId: "p1", deletedAt: null };
        }
        // Review of #652 — the project lookup behind this one throws.
        if (args?.where?.id === "a-projboom") {
          return { id: "a-projboom", projectId: "p-boom", deletedAt: null };
        }
        if (args?.where?.id === "a-deleted" && args.where.deletedAt !== null) {
          return { id: "a-deleted", projectId: "p1", deletedAt: new Date() };
        }
        return null;
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    // #655 — connector, background-run and job rooms authorize like their REST
    // reads. Every row below lives in `p1` (workspace `w1`, member `u1`); a
    // `*-boom` id makes the lookup throw; `*-slow` resolves late; a
    // `*-deleted` row is soft-deleted, so a lookup filtering on
    // `deletedAt: null` does not see it.
    repoConnection: {
      findFirst: vi.fn(async (args: { where: { id: string; deletedAt?: null } }) => {
        if (args.where.id === "c-boom") throw new Error("db down");
        if (args.where.id === "c-repo-deleted" && args.where.deletedAt !== null) {
          return { projectId: "p1" };
        }
        if (args.where.id === "c-slow") {
          await new Promise((r) => setTimeout(r, 50));
          return { projectId: "p1" };
        }
        // The project lookup behind this one throws.
        if (args.where.id === "c-projboom") return { projectId: "p-boom" };
        return args.where.id === "c-repo" ? { projectId: "p1" } : null;
      }),
    },
    databaseConnection: {
      findFirst: vi.fn(async (args: { where: { id: string; deletedAt?: null } }) => {
        if (args.where.id === "c-db-deleted" && args.where.deletedAt !== null) {
          return { projectId: "p1" };
        }
        return args.where.id === "c-db" ? { projectId: "p1" } : null;
      }),
    },
    backgroundRun: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        if (args.where.id === "r-boom") throw new Error("db down");
        return args.where.id === "r1" ? { projectId: "p1" } : null;
      }),
    },
    generatedDocument: {
      findFirst: vi.fn(async (args: { where: { id: string; deletedAt?: null } }) => {
        if (args.where.id === "d-deleted" && args.where.deletedAt !== null) {
          return { projectId: "p1" };
        }
        return args.where.id === "d1" ? { projectId: "p1" } : null;
      }),
    },
    importRun: {
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id === "ir1" ? { projectId: "p1" } : null,
      ),
    },
    impactAnalysis: {
      findFirst: vi.fn(async (args: { where: { id: string } }) =>
        args.where.id === "ia1" ? { id: "ia1" } : null,
      ),
    },
    // #142 — `subscribe:session` authorises like every session read: `u1`
    // owns the unscoped session `s1`; nobody else owns anything.
    aISession: {
      findFirst: vi.fn(async (args?: { where?: { id?: string; userId?: string } }) =>
        args?.where?.id === "s1" && args.where.userId === "u1"
          ? { id: "s1", userId: "u1", projectId: null, deletedAt: null }
          : null,
      ),
    },
    project: {
      // Non-admin path: returns the projects whose `createdById` matches the
      // actor. Honour the `where.createdById` filter so each user only "owns"
      // their own projects.
      findMany: vi.fn(async (args?: { where?: { createdById?: string } }) => {
        const createdById = args?.where?.createdById;
        if (createdById === "u1") return [{ id: "p1", name: "P1" }];
        return [];
      }),
      // #645 — `assertProjectAccess`: `p1` sits in workspace `w1`, whose only
      // member is `u1`.
      findUnique: vi.fn(
        async (args: {
          where: { id: string };
          select?: { workspace?: { select?: { members?: { where?: { userId?: string } } } } };
        }) => {
          if (args.where.id === "p-boom") throw new Error("db down");
          if (args.where.id !== "p1") return null;
          const memberId = args.select?.workspace?.select?.members?.where?.userId;
          return {
            workspaceId: "w1",
            workspace: { deletedAt: null, members: memberId === "u1" ? [{ id: "m1" }] : [] },
          };
        },
      ),
    },
  },
}));

// #655 — the impact-analysis read rule behind a `job:{id}` join: `ia1` touches
// `p1` only, which `u1` created (`listAccessibleProjectIds`).
vi.mock("../src/lib/impact-analysis/impact-analysis-read.js", () => ({
  getImpactAnalysisDetail: vi.fn(async (id: string) =>
    id === "ia1" ? { id: "ia1", projectIds: ["p1"], startedById: "u1" } : null,
  ),
}));

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import {
  createJobEventEmitter,
  _resetJobLifecycleMemory,
  rememberJobScope,
} from "../src/lib/socket/job-events.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { canJoinAnalysisRoom } from "../src/lib/socket/analysis-room-access.js";
import { canJoinConnectorRoom } from "../src/lib/socket/room-access.js";
import { wirePresenceHandlers } from "../src/lib/collaboration/presence.js";
import type { ClientToServerEvents, SocketAuthErrorEvent } from "@metis/shared";

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;

beforeAll(async () => {
  httpServer = http.createServer();
  io = createSocketServer(httpServer);
  // `src/server.ts` wires the artifact presence handlers on the same server.
  wirePresenceHandlers(io);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") port = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function makeClient(opts: {
  token?: string;
}): Promise<{ socket: ClientSocket; ok: boolean; err?: string }> {
  return new Promise((resolve) => {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: opts.token ? { token: opts.token } : {},
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    socket.on("connect", () => resolve({ socket, ok: true }));
    socket.on("connect_error", (err) => resolve({ socket, ok: false, err: err.message }));
  });
}

/** Connect as a developer and resolve once the server has sent `auth:ok`. */
async function connectAs(userId: string, username: string): Promise<ClientSocket> {
  const { accessToken } = issueTokens({
    userId,
    username,
    role: "developer",
    permissions: ["analysis.read"],
  });
  const socket = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token: accessToken },
    transports: ["websocket"],
    reconnection: false,
    timeout: 1500,
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("auth:ok", () => resolve());
    socket.on("connect_error", (err) => reject(err));
  });
  return socket;
}

describe("Socket.IO server", () => {
  it("rejects connections without a JWT", async () => {
    const { ok, err, socket } = await makeClient({});
    expect(ok).toBe(false);
    expect(err).toBe("UNAUTHORIZED");
    socket.close();
  });

  it("rejects connections with a malformed JWT", async () => {
    const { ok, err, socket } = await makeClient({ token: "garbage" });
    expect(ok).toBe(false);
    expect(err).toBe("TOKEN_INVALID");
    socket.close();
  });

  it("accepts a valid JWT, emits auth:ok, and supports room subscriptions", async () => {
    const { accessToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    const authOk = await new Promise<{ userId: string; username: string }>((resolve, reject) => {
      socket.on("auth:ok", resolve);
      socket.on("connect_error", (err) => reject(err));
    });
    expect(authOk.userId).toBe("u1");

    socket.emit("subscribe:project", { projectId: "p1" });
    socket.emit("subscribe:analysis", { analysisId: "a1" });
    socket.emit("subscribe:session", { sessionId: "s1" });
    // Give the server a tick to process room joins.
    await new Promise((r) => setTimeout(r, 50));

    const projectRoomSize = io.sockets.adapter.rooms.get("project:p1")?.size ?? 0;
    const analysisRoomSize = io.sockets.adapter.rooms.get("analysis:a1")?.size ?? 0;
    const sessionRoomSize = io.sockets.adapter.rooms.get("session:s1")?.size ?? 0;
    expect(projectRoomSize).toBe(1);
    expect(analysisRoomSize).toBe(1);
    expect(sessionRoomSize).toBe(1);

    socket.emit("unsubscribe:project", { projectId: "p1" });
    socket.emit("unsubscribe:analysis", { analysisId: "a1" });
    socket.emit("unsubscribe:session", { sessionId: "s1" });
    await new Promise((r) => setTimeout(r, 50));
    expect(io.sockets.adapter.rooms.get("project:p1")).toBeUndefined();

    socket.close();
  });

  it("#142 — refuses to join a session room the user does not own", async () => {
    const { accessToken } = issueTokens({
      userId: "u2",
      username: "mallory",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise((resolve, reject) => {
      socket.on("auth:ok", resolve);
      socket.on("connect_error", (err) => reject(err));
    });
    const denied = new Promise<{ message: string }>((resolve) => socket.on("auth:error", resolve));
    socket.emit("subscribe:session", { sessionId: "s1" });
    expect((await denied).message).toMatch(/FORBIDDEN/);
    expect(io.sockets.adapter.rooms.get("session:s1")?.size ?? 0).toBe(0);
    socket.close();
  });

  describe("#645 subscribe:analysis authorizes against the analysis's project", () => {
    async function subscribeAnalysis(
      userId: string,
      analysisId: unknown,
    ): Promise<{ socket: ClientSocket; errors: string[] }> {
      const socket = await connectAs(userId, userId);
      const errors: string[] = [];
      socket.on("auth:error", ({ message }: { message: string }) => errors.push(message));
      socket.emit("subscribe:analysis", { analysisId } as { analysisId: string });
      await new Promise((r) => setTimeout(r, 100));
      return { socket, errors };
    }
    const inRoom = (analysisId: string, socket: ClientSocket): boolean =>
      io.sockets.adapter.rooms.get(`analysis:${analysisId}`)?.has(socket.id!) ?? false;

    it("joins a member of the analysis's project workspace", async () => {
      const { socket, errors } = await subscribeAnalysis("u1", "a1");
      expect(errors).toEqual([]);
      expect(inRoom("a1", socket)).toBe(true);
      socket.close();
    });

    it("refuses a user outside the analysis's project and emits auth:error", async () => {
      const { socket, errors } = await subscribeAnalysis("u2", "a1");
      expect(errors).toEqual(["FORBIDDEN: no access to analysis"]);
      expect(inRoom("a1", socket)).toBe(false);
      socket.close();
    });

    it("refuses an unknown or soft-deleted analysis id with the same error", async () => {
      for (const id of ["a-missing", "a-deleted"]) {
        const { socket, errors } = await subscribeAnalysis("u1", id);
        expect(errors).toEqual(["FORBIDDEN: no access to analysis"]);
        expect(inRoom(id, socket)).toBe(false);
        socket.close();
      }
    });

    it("fails closed when the analysis lookup throws", async () => {
      const { socket, errors } = await subscribeAnalysis("u1", "a-boom");
      expect(errors).toEqual(["FORBIDDEN: no access to analysis"]);
      expect(inRoom("a-boom", socket)).toBe(false);
      socket.close();
    });

    it("ignores a missing or non-string analysisId without touching the database", async () => {
      const { prisma } = await import("../src/lib/prisma.js");
      const findFirst = vi.mocked(prisma.analysis.findFirst);
      findFirst.mockClear();
      for (const bad of [undefined, "", 42, { id: "a1" }]) {
        const { socket } = await subscribeAnalysis("u1", bad);
        expect(io.sockets.adapter.rooms.get("analysis:undefined")).toBeUndefined();
        expect(io.sockets.adapter.rooms.get("analysis:")).toBeUndefined();
        expect(io.sockets.adapter.rooms.get("analysis:42")).toBeUndefined();
        expect(io.sockets.adapter.rooms.get("analysis:[object Object]")).toBeUndefined();
        socket.close();
      }
      expect(findFirst).not.toHaveBeenCalled();
    });

    // Review of #652 — destructuring a null payload threw inside socket.io's
    // nextTick dispatch, an uncaught exception that killed the API process.
    it("survives a null or missing payload on subscribe and unsubscribe", async () => {
      const uncaught: unknown[] = [];
      const onUncaught = (err: unknown): void => {
        uncaught.push(err);
      };
      process.on("uncaughtException", onUncaught);
      try {
        const socket = await connectAs("u1", "u1");
        for (const event of ["subscribe:analysis", "unsubscribe:analysis"] as const) {
          (socket.emit as (ev: string, ...args: unknown[]) => void)(event, null);
          (socket.emit as (ev: string, ...args: unknown[]) => void)(event);
        }
        await new Promise((r) => setTimeout(r, 100));
        expect(uncaught).toEqual([]);
        // The same socket still subscribes normally afterwards.
        socket.emit("subscribe:analysis", { analysisId: "a1" });
        await new Promise((r) => setTimeout(r, 100));
        expect(inRoom("a1", socket)).toBe(true);
        socket.close();
      } finally {
        process.off("uncaughtException", onUncaught);
      }
    });

    // Review of #652 — an unsubscribe that lands while the access check is in
    // flight must win; the late check must not join the socket afterwards.
    it("does not join when unsubscribed before the access check resolves", async () => {
      const socket = await connectAs("u1", "u1");
      socket.emit("subscribe:analysis", { analysisId: "a-slow" });
      socket.emit("unsubscribe:analysis", { analysisId: "a-slow" });
      await new Promise((r) => setTimeout(r, 150));
      expect(inRoom("a-slow", socket)).toBe(false);
      // A later subscribe to the same id still joins.
      socket.emit("subscribe:analysis", { analysisId: "a-slow" });
      await new Promise((r) => setTimeout(r, 150));
      expect(inRoom("a-slow", socket)).toBe(true);
      socket.close();
    });

    // Review of #652 — a database failure behind the project check is not a
    // denial: it propagates so the handler logs it, and the socket still fails closed.
    it("rethrows a non-AppError from the project check and still refuses the socket", async () => {
      const user = { userId: "u1", username: "u1", role: "developer", permissions: [] } as never;
      await expect(canJoinAnalysisRoom(user, "a-projboom")).rejects.toThrow("db down");
      await expect(
        canJoinAnalysisRoom({ ...(user as object), userId: "u2" } as never, "a1"),
      ).resolves.toBe(false);
      const { socket, errors } = await subscribeAnalysis("u1", "a-projboom");
      expect(errors).toEqual(["FORBIDDEN: no access to analysis"]);
      expect(inRoom("a-projboom", socket)).toBe(false);
      socket.close();
    });
  });

  /**
   * A job shorter than the trigger round-trip emits its whole lifecycle before
   * the client can join `job:{id}`, so the surface never learns it finished
   * (observed on the embeddings reindex, which sat on "Reindexing…" forever).
   * Subscribing replays the last known transition to that socket.
   */
  it("replays the last job:lifecycle event to a late subscriber", async () => {
    _resetJobLifecycleMemory();
    const { accessToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });

    // The job runs to completion BEFORE anyone is in the room.
    createJobEventEmitter(io).completed(
      "embeddings-reindex",
      "late-job",
      "p1",
      "Reindexed 4 of 4 chunks.",
    );

    const replayed = new Promise<{ status: string; message?: string; jobId: string }>((resolve) => {
      socket.on("job:lifecycle", resolve);
    });
    socket.emit("subscribe:job", { jobId: "late-job" });
    const event = await replayed;
    expect(event.jobId).toBe("late-job");
    expect(event.status).toBe("completed");
    expect(event.message).toBe("Reindexed 4 of 4 chunks.");

    socket.close();
  });

  /**
   * The replay above is a READ of stored job state, so it must not become a
   * way around project scoping: `subscribe:job` itself is capability-based
   * (holding the id is the capability), but a guessed id must not hand back
   * another project's job state. `u1` owns `p1` only, per the prisma mock.
   */
  it("replays a project-scoped job to a member of that project", async () => {
    _resetJobLifecycleMemory();
    const { accessToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });

    createJobEventEmitter(io).completed("analysis", "mine-job", "p1", "done");

    const replayed = new Promise<{ jobId: string }>((resolve) => {
      socket.on("job:lifecycle", resolve);
    });
    socket.emit("subscribe:job", { jobId: "mine-job" });
    expect((await replayed).jobId).toBe("mine-job");

    socket.close();
  });

  it("does NOT replay a job scoped to a project the subscriber cannot access", async () => {
    _resetJobLifecycleMemory();
    const { accessToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });

    createJobEventEmitter(io).completed("analysis", "foreign-job", "p-other", "secret progress");

    createJobEventEmitter(io).completed("analysis", "allowed-job", "p1", "visible");

    const received: Array<{ jobId: string }> = [];
    socket.on("job:lifecycle", (e: { jobId: string }) => received.push(e));
    socket.emit("subscribe:job", { jobId: "foreign-job" });
    // The authz check is async, so a fixed sleep fails open against a slow
    // replay. Barrier instead: a later subscribe to an allowed job on the same
    // socket must replay first, and only then is silence for the foreign job
    // meaningful.
    socket.emit("subscribe:job", { jobId: "allowed-job" });
    await vi.waitFor(() => expect(received.map((e) => e.jobId)).toContain("allowed-job"));
    expect(received.map((e) => e.jobId)).toEqual(["allowed-job"]);

    socket.close();
  });

  /**
   * #510 — `subscribe:job` also replays the latest `job:doc-section` state of
   * each section. A section that finished while the socket was down (a
   * reconnect drops its rooms) was otherwise only seen on the next refetch.
   */
  it("replays the latest job:doc-section state of each section to a member", async () => {
    _resetJobLifecycleMemory();
    const socket = await connectAs("u1", "alice");
    const emitter = createJobEventEmitter(io);
    emitter.started("doc-generation", "doc-job", "p1");
    emitter.docSection({
      jobId: "doc-job",
      projectId: "p1",
      section: "Overview",
      status: "generating",
    });
    emitter.docSection({ jobId: "doc-job", projectId: "p1", section: "Risks", status: "done" });
    emitter.docSection({ jobId: "doc-job", projectId: "p1", section: "Overview", status: "done" });

    const received: Array<{ section: string; status: string }> = [];
    socket.on("job:doc-section", (e: { section: string; status: string }) => received.push(e));
    socket.emit("subscribe:job", { jobId: "doc-job" });
    await vi.waitFor(() =>
      expect(received.map((e) => [e.section, e.status])).toEqual([
        ["Overview", "done"],
        ["Risks", "done"],
      ]),
    );
    socket.close();
  });

  it("replays doc-sections even when no lifecycle event is remembered", async () => {
    _resetJobLifecycleMemory();
    const socket = await connectAs("u1", "alice");
    createJobEventEmitter(io).docSection({
      jobId: "sections-only",
      projectId: "p1",
      section: "Overview",
      status: "done",
    });
    const received: Array<{ section: string }> = [];
    socket.on("job:doc-section", (e: { section: string }) => received.push(e));
    socket.emit("subscribe:job", { jobId: "sections-only" });
    await vi.waitFor(() => expect(received.map((e) => e.section)).toEqual(["Overview"]));
    socket.close();
  });

  it("does NOT replay doc-sections of a project the subscriber cannot access", async () => {
    _resetJobLifecycleMemory();
    const socket = await connectAs("u1", "alice");
    createJobEventEmitter(io).docSection({
      jobId: "foreign-doc",
      projectId: "p-other",
      section: "Secret section",
      status: "done",
    });
    createJobEventEmitter(io).docSection({
      jobId: "allowed-doc",
      projectId: "p1",
      section: "Visible section",
      status: "done",
    });
    const received: Array<{ jobId: string }> = [];
    socket.on("job:doc-section", (e: { jobId: string }) => received.push(e));
    socket.emit("subscribe:job", { jobId: "foreign-doc" });
    // Barrier rather than a fixed sleep (which fails open on a slow replay):
    // wait for an allowed job's replay on the same socket, then assert.
    socket.emit("subscribe:job", { jobId: "allowed-doc" });
    await vi.waitFor(() => expect(received.map((e) => e.jobId)).toContain("allowed-doc"));
    expect(received.map((e) => e.jobId)).toEqual(["allowed-doc"]);
    socket.close();
  });

  it("replays only the sections of the project the gate checked", async () => {
    _resetJobLifecycleMemory();
    const socket = await connectAs("u1", "alice");
    const emitter = createJobEventEmitter(io);
    emitter.started("doc-generation", "mixed-job", "p1");
    emitter.docSection({
      jobId: "mixed-job",
      projectId: "p-other",
      section: "Foreign",
      status: "done",
    });
    const sections: unknown[] = [];
    socket.on("job:doc-section", (e: unknown) => sections.push(e));
    const lifecycle = new Promise<void>((resolve) => socket.on("job:lifecycle", () => resolve()));
    socket.emit("subscribe:job", { jobId: "mixed-job" });
    await lifecycle;
    await new Promise((r) => setTimeout(r, 100));
    expect(sections).toEqual([]);
    socket.close();
  });

  /**
   * #510 acceptance: a section completed during an outage reaches the client
   * after reconnect. The client drops, the section finishes into a room it is
   * no longer in, and the re-subscribe on the next connect (what
   * `ui/src/lib/job-rooms.ts` sends) brings it back.
   */
  it("delivers a section completed during an outage after the reconnect re-subscribe", async () => {
    _resetJobLifecycleMemory();
    const { accessToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    const statuses: string[] = [];
    socket.on("job:doc-section", (e: { status: string }) => statuses.push(e.status));
    await new Promise<void>((resolve) => socket.once("auth:ok", () => resolve()));
    const emitter = createJobEventEmitter(io);
    emitter.docSection({
      jobId: "outage-job",
      projectId: "p1",
      section: "Overview",
      status: "generating",
    });
    socket.emit("subscribe:job", { jobId: "outage-job" });
    await vi.waitFor(() => expect(statuses).toEqual(["generating"]));

    socket.disconnect();
    emitter.docSection({
      jobId: "outage-job",
      projectId: "p1",
      section: "Overview",
      status: "done",
    });
    expect(statuses).toEqual(["generating"]);

    socket.connect();
    await new Promise<void>((resolve) => socket.once("auth:ok", () => resolve()));
    socket.emit("subscribe:job", { jobId: "outage-job" });
    await vi.waitFor(() => expect(statuses).toEqual(["generating", "done"]));
    socket.close();
  });

  describe("#655 connector, background-run and job rooms authorize like their REST reads", () => {
    type RoomEvent = "subscribe:connector" | "subscribe:bg-run" | "subscribe:job";
    const FIELD: Record<RoomEvent, string> = {
      "subscribe:connector": "connectorId",
      "subscribe:bg-run": "runId",
      "subscribe:job": "jobId",
    };
    const ROOM: Record<RoomEvent, string> = {
      "subscribe:connector": "connector",
      "subscribe:bg-run": "run",
      "subscribe:job": "job",
    };
    const DENIAL: Record<RoomEvent, string> = {
      "subscribe:connector": "FORBIDDEN: no access to connector",
      "subscribe:bg-run": "FORBIDDEN: no access to background run",
      "subscribe:job": "FORBIDDEN: no access to job",
    };

    /**
     * Subscribe and settle: resolves on the denial, or once the socket is in
     * the room — never on a fixed sleep, which would fail open on a slow check.
     */
    async function subscribe(
      userId: string,
      event: RoomEvent,
      id: string,
    ): Promise<{ joined: boolean; errors: SocketAuthErrorEvent[] }> {
      const socket = await connectAs(userId, userId);
      const errors: SocketAuthErrorEvent[] = [];
      socket.on("auth:error", (payload: SocketAuthErrorEvent) => errors.push(payload));
      const room = `${ROOM[event]}:${id}`;
      (socket.emit as (ev: string, ...args: unknown[]) => void)(event, { [FIELD[event]]: id });
      await vi.waitFor(() =>
        expect(
          errors.length > 0 || (io.sockets.adapter.rooms.get(room)?.has(socket.id!) ?? false),
        ).toBe(true),
      );
      const joined = io.sockets.adapter.rooms.get(room)?.has(socket.id!) ?? false;
      socket.close();
      return { joined, errors };
    }

    const cases: Array<[RoomEvent, string, string]> = [
      ["subscribe:connector", "c-repo", "c-boom"],
      ["subscribe:connector", "c-db", "c-boom"],
      ["subscribe:bg-run", "r1", "r-boom"],
      // A job no event has named yet is scoped from its row.
      ["subscribe:job", "a1", "a-boom"],
      ["subscribe:job", "d1", "a-boom"],
      ["subscribe:job", "ir1", "a-boom"],
    ];

    it.each(cases)("%s %s joins a member of the owning project", async (event, id) => {
      expect(await subscribe("u1", event, id)).toEqual({ joined: true, errors: [] });
    });

    it.each(cases)(
      "%s %s refuses an outsider, an unknown id and a failed lookup alike",
      async (event, id, boomId) => {
        // Exactly `{ message, room }`: the same message whatever the reason,
        // and the room the client itself named, so nothing tells them apart.
        const denied = (roomId: string) => ({
          joined: false,
          errors: [{ message: DENIAL[event], room: `${ROOM[event]}:${roomId}` }],
        });
        expect(await subscribe("u2", event, id)).toEqual(denied(id));
        expect(await subscribe("u1", event, `${id}-missing`)).toEqual(denied(`${id}-missing`));
        expect(await subscribe("u1", event, boomId)).toEqual(denied(boomId));
      },
    );

    // A soft-deleted connector or job is refused to a member of its project,
    // exactly as the REST read 404s it. Each mock only hides its `*-deleted`
    // row when the lookup filters on `deletedAt: null`, so dropping that
    // filter from any lookup in `room-access.ts` turns its row red here.
    it.each<[RoomEvent, string]>([
      ["subscribe:connector", "c-repo-deleted"],
      ["subscribe:connector", "c-db-deleted"],
      ["subscribe:job", "d-deleted"],
      ["subscribe:job", "a-deleted"],
    ])("%s %s refuses a soft-deleted resource to a project member", async (event, id) => {
      expect(await subscribe("u1", event, id)).toEqual({
        joined: false,
        errors: [{ message: DENIAL[event], room: `${ROOM[event]}:${id}` }],
      });
    });

    // A denial answers `false`; only a failure that is not an access decision
    // (the database) propagates, so the handler logs it as a failed check.
    it("answers a denial with false and rethrows a database failure", async () => {
      const user = { userId: "u2", username: "u2", role: "developer", permissions: [] } as never;
      await expect(canJoinConnectorRoom(user, "c-repo")).resolves.toBe(false);
      await expect(canJoinConnectorRoom(user, "c-projboom")).rejects.toThrow("db down");
      expect(await subscribe("u1", "subscribe:connector", "c-projboom")).toEqual({
        joined: false,
        errors: [{ message: "FORBIDDEN: no access to connector", room: "connector:c-projboom" }],
      });
    });

    it("does not join when unsubscribed before the access check resolves", async () => {
      const socket = await connectAs("u1", "u1");
      const inRoom = (): boolean =>
        io.sockets.adapter.rooms.get("connector:c-slow")?.has(socket.id!) ?? false;
      socket.emit("subscribe:connector", { connectorId: "c-slow" });
      socket.emit("unsubscribe:connector", { connectorId: "c-slow" });
      await new Promise((r) => setTimeout(r, 150));
      expect(inRoom()).toBe(false);
      socket.emit("subscribe:connector", { connectorId: "c-slow" });
      await vi.waitFor(() => expect(inRoom()).toBe(true));
      socket.emit("unsubscribe:connector", { connectorId: "c-slow" });
      await vi.waitFor(() => expect(inRoom()).toBe(false));
      socket.close();
    });

    it("leaves background-run and job rooms on unsubscribe", async () => {
      const socket = await connectAs("u1", "u1");
      const rooms = (): string[] => [...(io.sockets.adapter.sids.get(socket.id!) ?? [])];
      socket.emit("subscribe:bg-run", { runId: "r1" });
      socket.emit("subscribe:job", { jobId: "a1" });
      await vi.waitFor(() => expect(rooms()).toEqual(expect.arrayContaining(["run:r1", "job:a1"])));
      socket.emit("unsubscribe:bg-run", { runId: "r1" });
      socket.emit("unsubscribe:job", { jobId: "a1" });
      await vi.waitFor(() => expect(rooms()).not.toContain("run:r1"));
      await vi.waitFor(() => expect(rooms()).not.toContain("job:a1"));
      socket.close();
    });

    it("authorizes a job named by an event against that event's project", async () => {
      _resetJobLifecycleMemory();
      const emitter = createJobEventEmitter(io);
      emitter.started("spec-kit", "mem-p1", "p1");
      emitter.started("spec-kit", "mem-other", "p-other");
      expect(await subscribe("u1", "subscribe:job", "mem-p1")).toEqual({
        joined: true,
        errors: [],
      });
      expect(await subscribe("u2", "subscribe:job", "mem-p1")).toEqual({
        joined: false,
        errors: [{ message: "FORBIDDEN: no access to job", room: "job:mem-p1" }],
      });
      expect(await subscribe("u1", "subscribe:job", "mem-other")).toEqual({
        joined: false,
        errors: [{ message: "FORBIDDEN: no access to job", room: "job:mem-other" }],
      });
    });

    it("authorizes a queued job whose scope was recorded before its first event", async () => {
      _resetJobLifecycleMemory();
      rememberJobScope("prr-1-manual", "pr-review", "p1");
      expect(await subscribe("u1", "subscribe:job", "prr-1-manual")).toEqual({
        joined: true,
        errors: [],
      });
      expect(await subscribe("u2", "subscribe:job", "prr-1-manual")).toEqual({
        joined: false,
        errors: [{ message: "FORBIDDEN: no access to job", room: "job:prr-1-manual" }],
      });
    });

    it("authorizes an impact-analysis job by the impact analysis's read rule", async () => {
      _resetJobLifecycleMemory();
      // From its row, and from a remembered event, which carries no project.
      expect(await subscribe("u1", "subscribe:job", "ia1")).toEqual({ joined: true, errors: [] });
      expect(await subscribe("u2", "subscribe:job", "ia1")).toEqual({
        joined: false,
        errors: [{ message: "FORBIDDEN: no access to job", room: "job:ia1" }],
      });
      createJobEventEmitter(io).started("impact-analysis", "ia1", null);
      expect(await subscribe("u1", "subscribe:job", "ia1")).toEqual({ joined: true, errors: [] });
      expect(await subscribe("u2", "subscribe:job", "ia1")).toEqual({
        joined: false,
        errors: [{ message: "FORBIDDEN: no access to job", room: "job:ia1" }],
      });
    });

    it("admits only an admin to any other job without a project", async () => {
      _resetJobLifecycleMemory();
      createJobEventEmitter(io).completed("pr-review", "prr-system", null, "done");
      expect(await subscribe("u1", "subscribe:job", "prr-system")).toEqual({
        joined: false,
        errors: [{ message: "FORBIDDEN: no access to job", room: "job:prr-system" }],
      });
      const admin = await connectAs("u-admin", "root");
      const replayed = new Promise<{ jobId: string }>((resolve) =>
        admin.on("job:lifecycle", resolve),
      );
      admin.emit("subscribe:job", { jobId: "prr-system" });
      expect((await replayed).jobId).toBe("prr-system");
      expect(io.sockets.adapter.rooms.get("job:prr-system")?.has(admin.id!)).toBe(true);
      admin.close();
    });

    it("delivers live job events to a member only", async () => {
      _resetJobLifecycleMemory();
      const emitter = createJobEventEmitter(io);
      emitter.started("spec-kit", "live-job", "p1");
      const member = await connectAs("u1", "u1");
      const outsider = await connectAs("u2", "u2");
      const got: Record<string, string[]> = { member: [], outsider: [] };
      member.on("job:lifecycle", (e: { status: string }) => got.member!.push(e.status));
      outsider.on("job:lifecycle", (e: { status: string }) => got.outsider!.push(e.status));
      const denied = new Promise<void>((resolve) => outsider.on("auth:error", () => resolve()));
      member.emit("subscribe:job", { jobId: "live-job" });
      outsider.emit("subscribe:job", { jobId: "live-job" });
      await denied;
      await vi.waitFor(() => expect(got.member).toEqual(["started"]));
      emitter.completed("spec-kit", "live-job", "p1");
      await vi.waitFor(() => expect(got.member).toEqual(["started", "completed"]));
      expect(got.outsider).toEqual([]);
      member.close();
      outsider.close();
    });
  });

  // SEC-5: subscribe:mcp must be admin-only.
  it("rejects subscribe:mcp from non-admin and emits auth:error", async () => {
    const { accessToken } = issueTokens({
      userId: "u-dev",
      username: "dev",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });
    const errPromise = new Promise<{ message: string }>((resolve) => {
      socket.on("auth:error", resolve);
    });
    socket.emit("subscribe:mcp");
    const err = await errPromise;
    expect(err.message).toMatch(/FORBIDDEN/);
    await new Promise((r) => setTimeout(r, 50));
    expect(io.sockets.adapter.rooms.get("mcp:status")).toBeUndefined();
    socket.close();
  });

  it("allows subscribe:mcp for admin role", async () => {
    const { accessToken } = issueTokens({
      userId: "u-admin",
      username: "admin",
      role: "admin",
      permissions: ["mcp.manage"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });
    socket.emit("subscribe:mcp");
    await new Promise((r) => setTimeout(r, 50));
    expect(io.sockets.adapter.rooms.get("mcp:status")?.size ?? 0).toBe(1);
    socket.close();
  });

  // #255 — cross-project isolation: a non-member must be rejected from another
  // project's room and receive NO events broadcast to it.
  it("rejects subscribe:project for a project the user cannot access", async () => {
    const { accessToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "developer",
      permissions: ["analysis.read"],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });
    const errPromise = new Promise<{ message: string }>((resolve) => {
      socket.on("auth:error", resolve);
    });
    // u1 owns only p1 (per the prisma mock); p-other belongs to another team.
    socket.emit("subscribe:project", { projectId: "p-other" });
    const err = await errPromise;
    expect(err.message).toMatch(/FORBIDDEN/);

    await new Promise((r) => setTimeout(r, 50));
    // The socket never joined the room → it receives no broadcast to it.
    expect(io.sockets.adapter.rooms.get("project:p-other")).toBeUndefined();

    // Prove no events leak: emit into the room and confirm nothing arrives.
    let leaked = false;
    socket.on("job:lifecycle", () => {
      leaked = true;
    });
    io.to("project:p-other").emit("job:lifecycle", {
      kind: "analysis",
      jobId: "j1",
      projectId: "p-other",
      status: "failed",
      error: "secret detail",
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(leaked).toBe(false);
    socket.close();
  });

  it("allows subscribe:project for an admin regardless of ownership", async () => {
    const { accessToken } = issueTokens({
      userId: "u-admin",
      username: "admin",
      role: "admin",
      permissions: [],
    });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: accessToken },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", (err) => reject(err));
    });
    socket.emit("subscribe:project", { projectId: "p-other" });
    await new Promise((r) => setTimeout(r, 50));
    expect(io.sockets.adapter.rooms.get("project:p-other")?.size ?? 0).toBe(1);
    socket.close();
  });
});

describe("#617 the handshake trusts live user state, not the token", () => {
  afterEach(() => {
    authDb.accounts.clear();
    authDb.roles.clear();
    authDb.lookupError = null;
  });

  function tokenFor(userId: string, role: "admin" | "developer" | "reader" = "developer") {
    return issueTokens({ userId, username: userId, role, permissions: [] }).accessToken;
  }

  it.each([
    ["soft-deleted", { status: "active", deletedAt: new Date() }],
    ["disabled", { status: "disabled", deletedAt: null }],
  ])("rejects a %s user's unexpired token with UNAUTHORIZED", async (_label, state) => {
    authDb.accounts.set("u-gone", { username: "gone", ...state });
    const { ok, err, socket } = await makeClient({ token: tokenFor("u-gone") });
    expect(ok).toBe(false);
    expect(err).toBe("UNAUTHORIZED");
    // No server socket ever ran `attachHandlers` for the user.
    expect(io.sockets.adapter.rooms.get("user:u-gone")).toBeUndefined();
    socket.close();
  });

  it("fails closed when the user lookup throws", async () => {
    authDb.lookupError = new Error("db down");
    const { ok, err, socket } = await makeClient({ token: tokenFor("u-flaky") });
    expect(ok).toBe(false);
    expect(err).toBe("UNAUTHORIZED");
    socket.close();
  });

  it("emits auth:ok with the username stored on the user row", async () => {
    authDb.accounts.set("u-renamed", { username: "renamed", status: "active", deletedAt: null });
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: tokenFor("u-renamed") },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    const ok = await new Promise<{ userId: string; username: string }>((resolve, reject) => {
      socket.on("auth:ok", resolve);
      socket.on("connect_error", reject);
    });
    expect(ok).toEqual({ userId: "u-renamed", username: "renamed" });
    socket.close();
  });

  it("gates rooms on the durable role: a demoted admin's token cannot subscribe:mcp", async () => {
    authDb.roles.set("u-demoted", "developer");
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: tokenFor("u-demoted", "admin") },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", reject);
    });
    // Bounded: if the gate regresses the server emits no auth:error at all, and
    // an unbounded wait would hang to the suite timeout (x retries) instead of
    // failing fast with this message.
    const authErrors: string[] = [];
    socket.on("auth:error", ({ message }) => authErrors.push(message));
    socket.emit("subscribe:mcp");
    await vi.waitFor(
      () =>
        expect(
          authErrors,
          "a demoted admin's subscribe:mcp must be refused with auth:error FORBIDDEN",
        ).toEqual([expect.stringMatching(/FORBIDDEN/)]),
      { timeout: 2000 },
    );
    expect(io.sockets.adapter.rooms.get("mcp:status")?.has(socket.id!) ?? false).toBe(false);
    socket.close();
  });

  it("gates rooms on the durable role: a promoted reader's token may subscribe:mcp", async () => {
    authDb.roles.set("u-promoted", "admin");
    const socket = ioClient(`http://127.0.0.1:${port}`, {
      auth: { token: tokenFor("u-promoted", "reader") },
      transports: ["websocket"],
      reconnection: false,
      timeout: 1500,
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("auth:ok", () => resolve());
      socket.on("connect_error", reject);
    });
    socket.emit("subscribe:mcp");
    await vi.waitFor(() =>
      expect(io.sockets.adapter.rooms.get("mcp:status")?.has(socket.id!) ?? false).toBe(true),
    );
    socket.close();
  });
});

// #654 — every handler used to destructure its payload in the parameter
// list, so a null or missing payload threw inside socket.io's nextTick
// dispatch: an uncaught exception that took the whole API process down.
describe("#654 a null, missing or primitive payload never crashes the process", () => {
  // A `Record` over `keyof ClientToServerEvents`, so a new client event fails
  // typecheck until it is listed here too.
  const CLIENT_EVENTS: Record<keyof ClientToServerEvents, true> = {
    "subscribe:project": true,
    "unsubscribe:project": true,
    "subscribe:analysis": true,
    "unsubscribe:analysis": true,
    "subscribe:session": true,
    "unsubscribe:session": true,
    "subscribe:mcp": true,
    "unsubscribe:mcp": true,
    "subscribe:connector": true,
    "unsubscribe:connector": true,
    "subscribe:publish": true,
    "unsubscribe:publish": true,
    "subscribe:scheduler": true,
    "unsubscribe:scheduler": true,
    "subscribe:task": true,
    "unsubscribe:task": true,
    "subscribe:bg-run": true,
    "unsubscribe:bg-run": true,
    "subscribe:job": true,
    "unsubscribe:job": true,
    "subscribe:thread": true,
    "unsubscribe:thread": true,
    "presence:thread:join": true,
    "presence:thread:leave": true,
    "typing:start": true,
    "typing:stop": true,
    "presence:join": true,
    "presence:leave": true,
  };
  const events = Object.keys(CLIENT_EVENTS);

  it.each([
    ["null", [null]],
    ["no", []],
    ["a primitive", [42]],
  ] as const)("survives %s payload on every client event", async (_label, args) => {
    const crashes: unknown[] = [];
    const onCrash = (err: unknown): void => {
      crashes.push(err);
    };
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
    try {
      const socket = await connectAs("u1", "u1");
      const errors: string[] = [];
      socket.on("auth:error", ({ message }: { message: string }) => errors.push(message));
      const rawEmit = socket.emit as (ev: string, ...rest: unknown[]) => void;
      for (const event of events) rawEmit.call(socket, event, ...args);
      await new Promise((r) => setTimeout(r, 150));
      expect(crashes).toEqual([]);
      // A malformed payload is ignored silently, never answered with auth:error.
      // The one reply is payload-independent: subscribe:mcp takes no payload and
      // refuses this developer-role socket on permission alone (SEC-5).
      expect(errors).toEqual(["FORBIDDEN: subscribe:mcp requires mcp.manage permission"]);
      // No room was joined from the bad payload.
      const joined = [...(io.sockets.adapter.sids.get(socket.id!) ?? [])];
      expect(joined.filter((room) => /:(undefined|null|42)$/.test(room))).toEqual([]);
      // The same socket is still connected and still subscribes normally.
      expect(socket.connected).toBe(true);
      socket.emit("subscribe:connector", { connectorId: "c-repo" });
      await vi.waitFor(() =>
        expect(io.sockets.adapter.rooms.get("connector:c-repo")?.has(socket.id!) ?? false).toBe(
          true,
        ),
      );
      socket.close();
    } finally {
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
    }
  });

  it("ignores subscribe:project with no usable projectId instead of running the access check", async () => {
    const socket = await connectAs("u1", "u1");
    const errors: string[] = [];
    socket.on("auth:error", ({ message }: { message: string }) => errors.push(message));
    const rawEmit = socket.emit as (ev: string, ...rest: unknown[]) => void;
    for (const args of [[null], [], [42], [{ projectId: "" }], [{ projectId: 7 }]]) {
      rawEmit.call(socket, "subscribe:project", ...args);
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(errors).toEqual([]);
    socket.close();
  });
});
