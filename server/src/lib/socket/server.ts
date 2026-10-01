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
 * Heartbeat:
 *   - The Socket.IO ping/pong cycle is configured to fire every 30s; idle
 *     sockets are evicted after 60s.
 */
import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer, type Socket } from "socket.io";
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
import { getLastDocSections, getLastJobLifecycle } from "./job-events.js";
import { wireThreadRoomHandlers } from "./discussion-rooms.js";
import { wireDiscussionPresenceHandlers } from "./discussion-presence.js";
import { isMcpStatusRoom, mcpStatusRoomsFor } from "../mcp/status-rooms.js";
import { readLiveWorkspaceIds } from "../auth/live-workspace-ids.js";
import { loadLiveAuthPayload } from "../auth/live-auth-payload.js";
import { createChildLogger } from "../logger.js";
import { mcpStatusEvictionEpoch } from "./mcp-status-eviction.js";
import { userSocketRevocationEpoch } from "./user-disconnect.js";

const log = createChildLogger("socket");

interface SocketData {
  user: AuthPayload;
  /**
   * #613 — `userSocketRevocationEpoch()` taken before the handshake read the
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
}

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
  });

  // One async middleware with a single exit: `authenticateHandshake` either
  // resolves the live user or throws the rejection, so every failure path
  // (missing token, bad signature, inactive user, lookup error, an unexpected
  // throw) reaches `next(err)` here and fails closed. `next()` runs once,
  // outside the try, so a throw from it is never re-routed into a second call.
  io.use(async (socket, next) => {
    let user: AuthPayload;
    // #613 — taken BEFORE the live-user read (see `attachHandlers`).
    const revocationEpoch = userSocketRevocationEpoch();
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
  return io;
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
 * `reconnectUserSockets` would). A failed lookup disconnects (fail closed).
 */
async function recheckLiveUser(
  socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
): Promise<void> {
  const { userId, role } = socket.data.user;
  let live: AuthPayload | null;
  try {
    live = await loadLiveAuthPayload(userId);
  } catch (err) {
    log.warn("Socket live-user re-check failed — disconnecting", {
      socketId: socket.id,
      userId,
      error: (err as Error).message,
    });
    live = null;
  }
  if (!live) {
    socket.disconnect(true);
  } else if (live.role !== role) {
    socket.conn.close();
  }
}

function attachHandlers(
  socket: Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>,
): void {
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
  if (userSocketRevocationEpoch() !== socket.data.revocationEpoch) {
    void recheckLiveUser(socket);
  }

  socket.on("subscribe:project", ({ projectId }) => {
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
  socket.on("unsubscribe:project", ({ projectId }) => {
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
  socket.on("subscribe:analysis", ({ analysisId }) => {
    void socket.join(`analysis:${analysisId}`);
  });
  socket.on("unsubscribe:analysis", ({ analysisId }) => {
    void socket.leave(`analysis:${analysisId}`);
  });
  // #142 — the session room now carries tool-approval prompts (with the tool's
  // arguments), so only the session's owner, who can still reach its project,
  // may join it — the same rule as every other read of the session. It used to
  // join any id a client named.
  socket.on("subscribe:session", ({ sessionId }) => {
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
  socket.on("unsubscribe:session", ({ sessionId }) => {
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
      const evictionEpoch = mcpStatusEvictionEpoch();
      const rooms = await liveMcpStatusRooms();
      if (attempt !== mcpSubscription) return;
      leaveMcpStatusRoomsNotIn(rooms);
      await socket.join(rooms);
      if (mcpStatusEvictionEpoch() === evictionEpoch) return;
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

  socket.on("subscribe:connector", ({ connectorId }) => {
    if (!connectorId || typeof connectorId !== "string") return;
    void socket.join(`connector:${connectorId}`);
  });
  socket.on("unsubscribe:connector", ({ connectorId }) => {
    if (!connectorId || typeof connectorId !== "string") return;
    void socket.leave(`connector:${connectorId}`);
  });

  socket.on("subscribe:publish", ({ batchId }) => {
    if (!batchId || typeof batchId !== "string") return;
    if (!hasPermission(user.role, "issue.publish") && !hasPermission(user.role, "issue.preview")) {
      socket.emit("auth:error", { message: "FORBIDDEN" });
      return;
    }
    void socket.join(`publish:${batchId}`);
  });
  socket.on("unsubscribe:publish", ({ batchId }) => {
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
  socket.on("subscribe:task", ({ taskId }) => {
    if (!taskId || typeof taskId !== "string") return;
    if (!hasPermission(user.role, "task.read")) {
      socket.emit("auth:error", { message: "FORBIDDEN: subscribe:task requires task.read" });
      return;
    }
    void socket.join(`task:${taskId}`);
  });
  socket.on("unsubscribe:task", ({ taskId }) => {
    if (!taskId || typeof taskId !== "string") return;
    void socket.leave(`task:${taskId}`);
  });

  // Epic #238 (#239) — unified job-lifecycle rooms (`job:{jobId}`).
  // Analysis, doc-generation, and impact-analysis all broadcast here. Anyone
  // with a job id (returned from the trigger endpoint) may subscribe; finer
  // authz is enforced at the REST trigger layer that hands out the id.
  socket.on("subscribe:job", ({ jobId }) => {
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
  socket.on("unsubscribe:job", ({ jobId }) => {
    if (!jobId || typeof jobId !== "string") return;
    void socket.leave(`job:${jobId}`);
  });

  // Epic #156 — async background run rooms (`run:{runId}`).
  socket.on("subscribe:bg-run", ({ runId }) => {
    if (!runId || typeof runId !== "string") return;
    void socket.join(`run:${runId}`);
  });
  socket.on("unsubscribe:bg-run", ({ runId }) => {
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
