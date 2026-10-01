/**
 * Socket.IO server bootstrap.
 *
 * Auth model:
 *   - JWT supplied via `socket.handshake.auth.token` OR `Authorization` header.
 *   - Connections without a valid token are REJECTED at handshake (issue #22
 *     acceptance criterion 1) — no events are processed for unauth sockets.
 *   - #617 — the handshake then re-reads the user: a soft-deleted or inactive
 *     user is rejected, and `socket.data.user` carries the durable role and
 *     live workspaces, never the token's claims.
 *
 * Rooms:
 *   - `user:{id}` — personal room auto-joined on connect (NEVER from client input).
 *     Delivers `comment:mention` and `sla:deadline_expired` to exactly that user.
 *     The id is ALWAYS derived from `socket.data.user.userId` (verified JWT,
 *     re-read from the user row at handshake).
 *   - `project:{id}` — broadcast scope for project-level updates.
 *   - `analysis:{id}` — analysis run progress.
 *   - `session:{id}` — chat / agent session events.
 *
 * Cluster adapter (#622):
 *   - `opts.adapter` (from `resolveSocketClusterAdapter`, Postgres datasources
 *     only) relays room operations — evictions and emits — to every replica,
 *     and relays role-change reconnects and the #613 epochs through
 *     `wireUserRevocationRelay` / `wireMcpStatusEvictionRelay`. Presence
 *     lists are the exception: each replica emits its own list locally only
 *     (`collaboration/presence.ts`). Unset, Socket.IO's in-memory adapter
 *     reaches this replica only.
 *   - #649 — `opts.onAdapterListening` (the adapter's `onListening`) runs
 *     `revalidateLocalSockets` each time the adapter's `LISTEN` connection is
 *     (re)established, so a revocation published while it was down — and so
 *     never delivered here — is applied from the database instead.
 *
 * Heartbeat:
 *   - The Socket.IO ping/pong cycle is configured to fire every 30s; idle
 *     sockets are evicted after 60s.
 */
import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type ServerOptions, type Socket } from "socket.io";
import jwt from "jsonwebtoken";
import {
  hasPermission,
  type AuthPayload,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@metis/shared";
import { verifyAccessToken } from "../auth/jwt.js";
import { actorCanAccessProject } from "../scheduler/project-access.js";
import { loadAuthorizedSession } from "../ai/conversation/session-access.js";
import { canJoinAnalysisRoom } from "./analysis-room-access.js";
import { getLastDocSections, getLastJobLifecycle } from "./job-events.js";
import { wireThreadRoomHandlers } from "./discussion-rooms.js";
import { wireDiscussionPresenceHandlers } from "./discussion-presence.js";
import { isMcpStatusRoom, mcpStatusRoomsFor, mcpStatusWorkspaceRoom } from "../mcp/status-rooms.js";
import { readLiveWorkspaceIds } from "../auth/live-workspace-ids.js";
import { loadLiveAuthPayload } from "../auth/live-auth-payload.js";
import { createChildLogger } from "../logger.js";
import { mcpStatusEvictionEpoch, wireMcpStatusEvictionRelay } from "./mcp-status-eviction.js";
import { userSocketRevocationEpoch, wireUserRevocationRelay } from "./user-disconnect.js";
import { bumpEpoch } from "./revocation-relay.js";

const log = createChildLogger("socket");

interface SocketData {
  user: AuthPayload;
  /**
   * #613 — `userSocketRevocationEpoch(io)` taken before the handshake read the
   * live user; compared once the socket is in its `user:{id}` room.
   */
  revocationEpoch: number;
}

export type MetisIOServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export interface CreateSocketServerOptions {
  corsOrigin?: string;
  /** #622 — the cluster adapter; omit for the single-replica in-memory adapter. */
  adapter?: ServerOptions["adapter"];
  /**
   * #649 — the cluster adapter's `onListening`: registers a callback for every
   * (re)established `LISTEN` connection, on which every local socket is
   * re-validated.
   */
  onAdapterListening?: (listener: () => void) => void;
}

type MetisSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

export function createSocketServer(
  httpServer: HttpServer,
  opts: CreateSocketServerOptions = {},
): MetisIOServer {
  const io: MetisIOServer = new SocketIOServer(httpServer, {
    cors: {
      origin: opts.corsOrigin ?? process.env.CORS_ORIGIN ?? "http://localhost:3000",
      credentials: true,
    },
    pingInterval: 30_000,
    pingTimeout: 60_000,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
  });

  // One async middleware with a single exit: `authenticateHandshake` either
  // resolves the live user or throws the rejection, so every failure path
  // (missing token, bad signature, inactive user, lookup error, an unexpected
  // throw) reaches `next(err)` here and fails closed. `next()` runs once,
  // outside the try, so a throw from it is never re-routed into a second call.
  io.use(async (socket, next) => {
    let user: AuthPayload;
    // #613 — taken BEFORE the live-user read (see `attachHandlers`).
    const revocationEpoch = userSocketRevocationEpoch(io);
    try {
      user = await authenticateHandshake(socket);
    } catch (err) {
      return next(err as Error);
    }
    socket.data.user = user;
    socket.data.revocationEpoch = revocationEpoch;
    next();
  });

  io.on("connection", (socket) => attachHandlers(socket));
  // #622 — with the cluster adapter, a revocation or eviction handled on another
  // replica moves THIS replica's #613 epochs too, so a handshake or
  // `subscribe:mcp` in flight here re-reads; a role-change reconnect also closes
  // this replica's transports (see `reconnectUserSockets`).
  wireUserRevocationRelay(io, Boolean(opts.adapter));
  wireMcpStatusEvictionRelay(io, Boolean(opts.adapter));
  opts.onAdapterListening?.(() => void revalidateLocalSockets(io));
  return io;
}

/** Users re-read at once by `revalidateLocalSockets`, so a failover cannot flood the database pool. */
export const REVALIDATE_CONCURRENCY = 4;

/** Prefix of every `mcp:status` workspace room. */
const MCP_STATUS_WORKSPACE_ROOM_PREFIX = mcpStatusWorkspaceRoom("");

interface RevalidationState {
  /** Set by a call that arrived while this pass ran: run one more pass. */
  dirty: boolean;
  done: Promise<void>;
}

/** The `revalidateLocalSockets` pass in flight for each server, if any. */
const revalidations = new WeakMap<MetisIOServer, RevalidationState>();

/**
 * #649 — re-validate every socket connected to this replica against the
 * database, applying any revocation it missed while the cluster adapter's
 * `LISTEN` connection was down:
 *   - a user no longer live is disconnected, a changed role re-handshakes, and
 *     a failed lookup closes the transport (`applyLiveUser`, as #613's re-check);
 *   - a socket still in an `mcp:status` workspace room it no longer has a live
 *     membership of leaves it (#588). A failed membership lookup closes the
 *     transport, so the client re-handshakes and re-subscribes from live state.
 * Both #613 epochs are bumped first, so a handshake or `subscribe:mcp` in
 * flight re-reads too. Each user is read once, `REVALIDATE_CONCURRENCY` users
 * at a time. Never rejects.
 *
 * Single-flight per `io`: a call while a pass is running starts no second one.
 * It marks the pass dirty, and exactly one more full pass runs when it
 * finishes, which also sees a revocation committed after the running pass read
 * that user. A flapping `LISTEN` connection therefore never multiplies the read
 * bound. The returned promise settles once no pass is left to run.
 */
export function revalidateLocalSockets(io: MetisIOServer): Promise<void> {
  const running = revalidations.get(io);
  if (running) {
    running.dirty = true;
    return running.done;
  }
  const state: RevalidationState = { dirty: false, done: Promise.resolve() };
  revalidations.set(io, state);
  state.done = (async () => {
    try {
      do {
        state.dirty = false;
        await revalidateOnce(io);
      } while (state.dirty);
    } finally {
      revalidations.delete(io);
    }
  })();
  return state.done;
}

/** One full `revalidateLocalSockets` pass. */
async function revalidateOnce(io: MetisIOServer): Promise<void> {
  bumpEpoch(io, "revocation");
  bumpEpoch(io, "eviction");
  const byUser = new Map<string, MetisSocket[]>();
  for (const socket of io.of("/").sockets.values()) {
    const userId = socket.data.user.userId;
    const sockets = byUser.get(userId);
    if (sockets) sockets.push(socket);
    else byUser.set(userId, [socket]);
  }
  if (byUser.size === 0) return;
  log.info(
    "Re-validating sockets after the cluster adapter's LISTEN connection was (re)established",
    {
      users: byUser.size,
    },
  );
  const queue = [...byUser.values()];
  const worker = async (): Promise<void> => {
    for (let sockets = queue.shift(); sockets; sockets = queue.shift()) {
      await revalidateUserSockets(sockets);
    }
  };
  await Promise.all(Array.from({ length: REVALIDATE_CONCURRENCY }, worker));
}

/** Re-validate one user's sockets (`revalidateLocalSockets`). */
async function revalidateUserSockets(sockets: MetisSocket[]): Promise<void> {
  const userId = sockets[0].data.user.userId;
  let live: AuthPayload | null | undefined;
  try {
    live = await loadLiveAuthPayload(userId);
  } catch (err) {
    live = undefined;
    log.warn("Socket re-validation: live-user lookup failed — closing transports to re-handshake", {
      userId,
      error: (err as Error).message,
    });
  }
  const kept = sockets.filter((socket) => applyLiveUser(socket, live));
  // Each socket's workspace rooms BEFORE the membership read. A `subscribe:mcp`
  // that finishes during the read can join a workspace granted after the read's
  // snapshot, so only rooms held before the read are judged by it.
  const roomsBefore = new Map<MetisSocket, string[]>();
  for (const socket of kept) {
    const rooms = [...socket.rooms].filter((room) =>
      room.startsWith(MCP_STATUS_WORKSPACE_ROOM_PREFIX),
    );
    if (rooms.length > 0) roomsBefore.set(socket, rooms);
  }
  if (roomsBefore.size === 0) return;
  let allowed: Set<string>;
  try {
    allowed = new Set((await readLiveWorkspaceIds(userId)).map(mcpStatusWorkspaceRoom));
  } catch (err) {
    log.warn(
      "Socket re-validation: membership lookup failed — closing transports to re-handshake",
      {
        userId,
        error: (err as Error).message,
      },
    );
    for (const socket of roomsBefore.keys()) socket.conn.close();
    return;
  }
  for (const [socket, rooms] of roomsBefore) {
    for (const room of rooms) {
      if (!allowed.has(room)) void socket.leave(room);
    }
  }
}

/**
 * Resolve the live user for a socket handshake, or throw the error the client
 * receives as `connect_error` (`UNAUTHORIZED`, `TOKEN_EXPIRED`, `TOKEN_INVALID`).
 */
async function authenticateHandshake(
  socket: Pick<Socket, "id" | "handshake">,
): Promise<AuthPayload> {
  const auth = socket.handshake.auth as { token?: string } | undefined;
  const headerAuth = socket.handshake.headers.authorization;
  // Also accept the HttpOnly `metis.at` cookie sent by the browser when
  // connecting cross-port (localhost:3000 → localhost:4000).  The cookie
  // domain is `localhost` (not port-scoped) so it is included in the WS
  // upgrade handshake even though the socket server lives on a different
  // port from the Next.js app.
  const cookieHeader = socket.handshake.headers.cookie as string | undefined;
  const cookieToken = cookieHeader
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("metis.at="))
    ?.slice("metis.at=".length);
  const token =
    auth?.token ??
    (headerAuth?.startsWith("Bearer ") ? headerAuth.slice("Bearer ".length).trim() : undefined) ??
    cookieToken;
  if (!token) {
    log.warn("Socket handshake rejected: no token", { socketId: socket.id });
    throw new Error("UNAUTHORIZED");
  }
  let verified: AuthPayload;
  try {
    verified = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new Error("TOKEN_EXPIRED");
    if (err instanceof jwt.JsonWebTokenError) throw new Error("TOKEN_INVALID");
    throw err;
  }
  // #617 — a signature check alone admitted a SCIM-deprovisioned user's
  // unexpired token and authorized every room gate from its `role` claim.
  // Re-read the user as the HTTP path does (`refreshAuthenticatedUser`):
  // reject a user who is not live, and carry the durable role, username and
  // workspaces in `socket.data.user`. A lookup failure rejects (fail closed).
  let live: AuthPayload | null;
  try {
    live = await loadLiveAuthPayload(verified.userId);
  } catch (err) {
    log.warn("Socket handshake rejected: user lookup failed", {
      socketId: socket.id,
      userId: verified.userId,
      error: (err as Error).message,
    });
    throw new Error("UNAUTHORIZED");
  }
  if (!live) {
    log.warn("Socket handshake rejected: user is not active", {
      socketId: socket.id,
      userId: verified.userId,
    });
    throw new Error("UNAUTHORIZED");
  }
  return live;
}

/**
 * #613 — re-read the live user of a socket that may have missed a revocation,
 * and apply the one it missed: a user no longer live is disconnected (as
 * `disconnectUserSockets` would), and a changed role re-handshakes (as
 * `reconnectUserSockets` would).
 *
 * A FAILED lookup closes the transport rather than disconnecting: the client
 * treats `disconnect(true)` as final, so a transient database blip during an
 * unrelated revocation would park a legitimate user until they reload. A
 * transport close makes the client re-handshake, and `authenticateHandshake`
 * rejects that while the database is still down — fail closed, but recoverable.
 */
async function recheckLiveUser(socket: MetisSocket): Promise<void> {
  const { userId } = socket.data.user;
  let live: AuthPayload | null | undefined;
  try {
    live = await loadLiveAuthPayload(userId);
  } catch (err) {
    live = undefined;
    log.warn("Socket live-user re-check failed — closing transport to re-handshake", {
      socketId: socket.id,
      userId,
      error: (err as Error).message,
    });
  }
  applyLiveUser(socket, live);
}

/**
 * Apply a live-user read to `socket`: `undefined` (the lookup failed) closes
 * the transport, `null` (no longer live) disconnects, a changed role closes the
 * transport. Returns whether the socket was left as it is.
 */
function applyLiveUser(socket: MetisSocket, live: AuthPayload | null | undefined): boolean {
  // Only the role is compared: workspaces are re-read live by `subscribe:mcp`,
  // and the username is not security-relevant.
  if (live === undefined) {
    socket.conn.close();
  } else if (!live) {
    socket.disconnect(true);
  } else if (live.role !== socket.data.user.role) {
    socket.conn.close();
  } else {
    return true;
  }
  return false;
}

function attachHandlers(socket: MetisSocket): void {
  const user = socket.data.user;
  log.info("Socket connected", { socketId: socket.id, userId: user.userId });
  socket.emit("auth:ok", { userId: user.userId, username: user.username });

  // Issue #416 — OWASP A01 (Broken Access Control): auto-join the user's OWN
  // personal room using ONLY the verified JWT payload (`socket.data.user`).
  // This intentionally does NOT expose any `subscribe:user` handler — there is
  // no client-supplied room id, so cross-user room injection is structurally
  // impossible. Every (re)connection triggers this so reconnect is covered.
  void socket.join(`user:${user.userId}`);
  log.debug("Socket auto-joined personal room", {
    socketId: socket.id,
    room: `user:${user.userId}`,
  });
  // #613 — a role change or deprovision that committed after the handshake read
  // the live user, but whose `reconnectUserSockets` / `disconnectUserSockets`
  // ran before the join above, found no socket in `user:{id}` and missed this
  // one. Any such revocation moved the epoch, so re-read the user once.
  if (userSocketRevocationEpoch(socket.nsp.server) !== socket.data.revocationEpoch) {
    void recheckLiveUser(socket);
  }

  // #654 — no handler destructures its payload in the parameter list: a null or
  // missing payload threw inside socket.io's nextTick dispatch, an uncaught
  // exception that took the whole API process down. Each reads its field with
  // `?.` and ignores anything that is not a non-empty string.
  socket.on("subscribe:project", (payload) => {
    const projectId: unknown = payload?.projectId;
    if (!projectId || typeof projectId !== "string") return;
    // #255 — per-project authorization. The `project:{id}` room fans out
    // job-lifecycle, presence, and comment events; an authenticated client must
    // not be able to subscribe to a project it has no access to (OWASP A01,
    // broken access control). Mirror the route-layer project-scoping used by
    // epics #207/#208 via the shared `actorCanAccessProject` helper, which also
    // emits an audit row on denial. Admins pass; non-members are rejected and
    // never join the room (so they receive no events).
    void (async () => {
      try {
        const allowed = await actorCanAccessProject(
          { id: user.userId, role: user.role },
          projectId,
          { resource: "project_room", resourceId: projectId, action: "socket.subscribe:project" },
        );
        if (!allowed) {
          log.warn("Socket subscribe:project rejected — no project access", {
            socketId: socket.id,
            userId: user.userId,
            projectId,
          });
          socket.emit("auth:error", {
            message: "FORBIDDEN: no access to project",
          });
          return;
        }
        await socket.join(`project:${projectId}`);
      } catch (err) {
        log.warn("Socket subscribe:project failed", {
          socketId: socket.id,
          projectId,
          error: (err as Error).message,
        });
        socket.emit("auth:error", { message: "FORBIDDEN: no access to project" });
      }
    })();
  });
  socket.on("unsubscribe:project", (payload) => {
    const projectId: unknown = payload?.projectId;
    if (!projectId || typeof projectId !== "string") return;
    void socket.leave(`project:${projectId}`);
  });

  // Epic #475 (Phase 2, #480) — authz-gated discussion-thread rooms
  // (`thread:{id}`). Subscribing requires `canAccessThread` to pass; non-members
  // get `auth:error` and never join, so message/presence fan-out never leaks.
  wireThreadRoomHandlers(socket);

  // Epic #475 (Phase 2, #482) — per-thread presence + typing indicators.
  // Presence joins are authz-gated via `canAccessThread`; typing broadcasts are
  // scoped to other members of the thread room (never echoed to the sender).
  wireDiscussionPresenceHandlers(socket);
  // #645 — the analysis room carries promotion-blocked counts and failure
  // reasons, so only a user who can read the analysis's project may join it —
  // the same rule as `GET /api/analyses/:id`. It used to join any id named.
  // Review of #652 — the payload is read with `?.`, never destructured: a null
  // or missing payload threw inside socket.io's nextTick dispatch, an uncaught
  // exception that took the whole API process down.
  // Bumped per id by every subscribe/unsubscribe (as `subscribe:mcp` does,
  // #562), so an access check that resolves after a later unsubscribe does not join.
  const analysisSubscription = new Map<string, number>();
  const bumpAnalysisSubscription = (analysisId: string): number => {
    const attempt = (analysisSubscription.get(analysisId) ?? 0) + 1;
    analysisSubscription.set(analysisId, attempt);
    return attempt;
  };
  socket.on("subscribe:analysis", (payload) => {
    const analysisId: unknown = payload?.analysisId;
    if (!analysisId || typeof analysisId !== "string") return;
    const attempt = bumpAnalysisSubscription(analysisId);
    void (async () => {
      try {
        if (await canJoinAnalysisRoom(user, analysisId)) {
          if (analysisSubscription.get(analysisId) !== attempt) return;
          await socket.join(`analysis:${analysisId}`);
          return;
        }
      } catch (err) {
        log.warn("Socket subscribe:analysis failed", {
          socketId: socket.id,
          analysisId,
          error: (err as Error).message,
        });
      }
      socket.emit("auth:error", { message: "FORBIDDEN: no access to analysis" });
    })();
  });
  socket.on("unsubscribe:analysis", (payload) => {
    const analysisId: unknown = payload?.analysisId;
    if (!analysisId || typeof analysisId !== "string") return;
    bumpAnalysisSubscription(analysisId);
    void socket.leave(`analysis:${analysisId}`);
  });
  // #142 — the session room now carries tool-approval prompts (with the tool's
  // arguments), so only the session's owner, who can still reach its project,
  // may join it — the same rule as every other read of the session. It used to
  // join any id a client named.
  socket.on("subscribe:session", (payload) => {
    const sessionId: unknown = payload?.sessionId;
    if (!sessionId || typeof sessionId !== "string") return;
    void (async () => {
      try {
        await loadAuthorizedSession(user, sessionId);
        await socket.join(`session:${sessionId}`);
      } catch {
        socket.emit("auth:error", { message: "FORBIDDEN: no access to session" });
      }
    })();
  });
  socket.on("unsubscribe:session", (payload) => {
    const sessionId: unknown = payload?.sessionId;
    if (!sessionId || typeof sessionId !== "string") return;
    void socket.leave(`session:${sessionId}`);
  });
  // #562 — bumped by every subscribe/unsubscribe, so a subscribe whose
  // membership lookup resolves after a later unsubscribe does not join.
  let mcpSubscription = 0;
  socket.on("subscribe:mcp", () => {
    // SEC-5: only roles with `mcp.manage` (admin) may subscribe to the
    // mcp:status room. Status events leak server labels, scope, projectId,
    // and lastError strings — none of which non-admins should see.
    if (!hasPermission(user.role, "mcp.manage")) {
      log.warn("Socket subscribe:mcp rejected — insufficient role", {
        socketId: socket.id,
        userId: user.userId,
        role: user.role,
      });
      socket.emit("auth:error", {
        message: "FORBIDDEN: subscribe:mcp requires mcp.manage permission",
      });
      return;
    }
    // #340 / #353 — the shared room carries global events and those of projects
    // with no workspace; a user-scope server's events go only to its owner's
    // room and the admins' room, and a workspace project's only to that
    // workspace's room and the admins' room.
    // #562 — workspace rooms come from the user's live, non-deleted
    // memberships, not the token's `workspaces` claim, which still lists a
    // workspace deleted (or left) after the token was issued. A failed lookup
    // joins no workspace room (fail closed).
    const attempt = ++mcpSubscription;
    const liveMcpStatusRooms = async (): Promise<string[]> => {
      let liveWorkspaceIds: string[] = [];
      try {
        liveWorkspaceIds = await readLiveWorkspaceIds(user.userId);
      } catch (err) {
        log.warn("Socket subscribe:mcp membership lookup failed — no workspace rooms", {
          socketId: socket.id,
          userId: user.userId,
          error: (err as Error).message,
        });
      }
      return mcpStatusRoomsFor(user, liveWorkspaceIds);
    };
    // #588 — a repeat subscribe also LEAVES rooms no longer in the live set
    // (a workspace deleted or left since the last one), not only joins.
    const leaveMcpStatusRoomsNotIn = (rooms: string[]): void => {
      for (const room of [...socket.rooms]) {
        if (isMcpStatusRoom(room) && !rooms.includes(room)) void socket.leave(room);
      }
    };
    void (async () => {
      // #613 — taken BEFORE the membership read: an eviction that lands between
      // the read and the join finds this socket not yet in the room.
      const evictionEpoch = mcpStatusEvictionEpoch(socket.nsp.server);
      const rooms = await liveMcpStatusRooms();
      if (attempt !== mcpSubscription) return;
      leaveMcpStatusRoomsNotIn(rooms);
      await socket.join(rooms);
      if (mcpStatusEvictionEpoch(socket.nsp.server) === evictionEpoch) return;
      // An eviction ran since the read. Its write committed before it ran, so a
      // read started now sees it; one that commits later evicts this socket,
      // which is in the rooms now. One re-read therefore closes the window.
      const current = await liveMcpStatusRooms();
      if (attempt !== mcpSubscription) return;
      leaveMcpStatusRoomsNotIn(current);
    })();
  });
  socket.on("unsubscribe:mcp", () => {
    ++mcpSubscription;
    // Every mcp:status room this socket is in, whatever memberships it joined.
    for (const room of [...socket.rooms]) if (isMcpStatusRoom(room)) void socket.leave(room);
  });

  socket.on("subscribe:connector", (payload) => {
    const connectorId: unknown = payload?.connectorId;
    if (!connectorId || typeof connectorId !== "string") return;
    void socket.join(`connector:${connectorId}`);
  });
  socket.on("unsubscribe:connector", (payload) => {
    const connectorId: unknown = payload?.connectorId;
    if (!connectorId || typeof connectorId !== "string") return;
    void socket.leave(`connector:${connectorId}`);
  });

  socket.on("subscribe:publish", (payload) => {
    const batchId: unknown = payload?.batchId;
    if (!batchId || typeof batchId !== "string") return;
    if (!hasPermission(user.role, "issue.publish") && !hasPermission(user.role, "issue.preview")) {
      socket.emit("auth:error", { message: "FORBIDDEN" });
      return;
    }
    void socket.join(`publish:${batchId}`);
  });
  socket.on("unsubscribe:publish", (payload) => {
    const batchId: unknown = payload?.batchId;
    if (!batchId || typeof batchId !== "string") return;
    void socket.leave(`publish:${batchId}`);
  });

  // Phase 11 — scheduler + tasks rooms.
  socket.on("subscribe:scheduler", () => {
    if (!hasPermission(user.role, "scheduler.read")) {
      socket.emit("auth:error", {
        message: "FORBIDDEN: subscribe:scheduler requires scheduler.read",
      });
      return;
    }
    void socket.join("scheduler:status");
  });
  socket.on("unsubscribe:scheduler", () => {
    void socket.leave("scheduler:status");
  });
  socket.on("subscribe:task", (payload) => {
    const taskId: unknown = payload?.taskId;
    if (!taskId || typeof taskId !== "string") return;
    if (!hasPermission(user.role, "task.read")) {
      socket.emit("auth:error", { message: "FORBIDDEN: subscribe:task requires task.read" });
      return;
    }
    void socket.join(`task:${taskId}`);
  });
  socket.on("unsubscribe:task", (payload) => {
    const taskId: unknown = payload?.taskId;
    if (!taskId || typeof taskId !== "string") return;
    void socket.leave(`task:${taskId}`);
  });

  // Epic #238 (#239) — unified job-lifecycle rooms (`job:{jobId}`).
  // Analysis, doc-generation, and impact-analysis all broadcast here. Anyone
  // with a job id (returned from the trigger endpoint) may subscribe; finer
  // authz is enforced at the REST trigger layer that hands out the id.
  socket.on("subscribe:job", (payload) => {
    const jobId: unknown = payload?.jobId;
    if (!jobId || typeof jobId !== "string") return;
    void socket.join(`job:${jobId}`);
    // Replay the job's last known transition to THIS socket. A room only
    // delivers what is emitted while you are in it, and a client cannot
    // subscribe until the trigger endpoint has answered — so a short job
    // (the embeddings reindex finishes in milliseconds) emitted `started`
    // and `completed` into an empty room and the surface never learned the
    // job was done. Replay is idempotent: the client dedups terminal
    // handling by job id.
    //
    // Joining the room stays capability-based (holding the job id is the
    // capability; the REST trigger that hands the id out does the authz).
    // The REPLAY is a new READ of stored state, though, so where the
    // remembered event names a project it is gated by the same
    // `actorCanAccessProject` check `subscribe:project` uses — a guessed job
    // id must not become a way to read another project's job state. Events
    // with no `projectId` carry no project to scope to and replay as before.
    //
    // #510 — the latest `job:doc-section` state of each section replays too, so
    // a section that finished while the socket was down (a reconnect drops its
    // rooms) reaches the Documentation page without waiting for a refetch.
    // Doc-section events always name a project, so they always take the gate.
    const last = getLastJobLifecycle(jobId);
    if (last && !last.projectId) socket.emit("job:lifecycle", last);
    const sections = getLastDocSections(jobId);
    const scopedProjectId = last?.projectId ?? sections[0]?.projectId;
    if (!scopedProjectId) return;
    void (async () => {
      try {
        const allowed = await actorCanAccessProject(
          { id: user.userId, role: user.role },
          scopedProjectId,
          {
            resource: "job_replay",
            resourceId: jobId,
            action: "socket.subscribe:job",
          },
        );
        if (!allowed) return;
        if (last?.projectId) socket.emit("job:lifecycle", last);
        // Only sections of the project that was just checked.
        for (const section of sections) {
          if (section.projectId === scopedProjectId) socket.emit("job:doc-section", section);
        }
      } catch (err) {
        log.warn("socket.job_replay_authz_failed", {
          jobId,
          error: (err as Error).message,
        });
      }
    })();
  });
  socket.on("unsubscribe:job", (payload) => {
    const jobId: unknown = payload?.jobId;
    if (!jobId || typeof jobId !== "string") return;
    void socket.leave(`job:${jobId}`);
  });

  // Epic #156 — async background run rooms (`run:{runId}`).
  socket.on("subscribe:bg-run", (payload) => {
    const runId: unknown = payload?.runId;
    if (!runId || typeof runId !== "string") return;
    void socket.join(`run:${runId}`);
  });
  socket.on("unsubscribe:bg-run", (payload) => {
    const runId: unknown = payload?.runId;
    if (!runId || typeof runId !== "string") return;
    void socket.leave(`run:${runId}`);
  });

  socket.on("disconnect", (reason) => {
    log.info("Socket disconnected", { socketId: socket.id, reason });
  });

  // Application-level heartbeat (in addition to Socket.IO's ping/pong) — the
  // UI uses this to display "last seen" timestamps without piercing the
  // protocol layer.
  const heartbeat = setInterval(() => {
    socket.emit("heartbeat", { ts: Date.now() });
  }, 30_000);
  // Don't keep the event loop alive on shutdown.
  heartbeat.unref?.();
  socket.on("disconnect", () => clearInterval(heartbeat));
}
