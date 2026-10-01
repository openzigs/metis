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

import { createSocketServer, type MetisIOServer } from "../src/lib/socket/server.js";
import { createJobEventEmitter, _resetJobLifecycleMemory } from "../src/lib/socket/job-events.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { canJoinAnalysisRoom } from "../src/lib/socket/analysis-room-access.js";

let httpServer: http.Server;
let io: MetisIOServer;
let port: number;

beforeAll(async () => {
  httpServer = http.createServer();
  io = createSocketServer(httpServer);
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
      null,
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
