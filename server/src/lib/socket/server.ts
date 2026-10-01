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
 *   - #659 — on a clustered server `revalidateLocalSockets` also runs every
 *     `resolveSocketRevalidateIntervalMs()` (60 s, or
 *     `METIS_SOCKET_REVALIDATE_INTERVAL_MS`), because a revocation whose PUBLISH
 *     fails (only the publishing replica's pool times out, say) reaches no other
 *     replica and gives them no reconnect to react to. A sweep-only pass keeps a
 *     socket whose lookup failed (a blip is not a revocation, and closing would
 *     storm the database with reconnects); a pass a `LISTEN` reconnect asked for
 *     still closes it. Every pass bumps both #613 epochs, so a handshake or
 *     `subscribe:mcp` in flight at a tick re-reads once more — by design.
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
import { MAX_TIMEOUT_MS, envMs } from "../config/env-ms.js";
import { onClientEvent, onConnection, runDetached } from "./client-event-handler.js";

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
  /**
   * #659 — how often every local socket is re-validated against the database
   * (`revalidateLocalSockets`). Defaults to `resolveSocketRevalidateIntervalMs()`
   * when `adapter` is set, and to no sweep without it (one replica: every
   * revocation runs here, against these sockets, with no publish to lose). Must
   * be a positive, finite number of milliseconds no larger than `MAX_TIMEOUT_MS`;
   * anything else throws a `RangeError`, because Node would fire such a timer
   * about every millisecond.
   */
  revalidateIntervalMs?: number;
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
  // Before anything attaches to `httpServer`, so a bad interval leaves it untouched.
  if (opts.revalidateIntervalMs !== undefined) {
    assertRevalidateInterval(opts.revalidateIntervalMs);
  }
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

  // #658 — a throw from `attachHandlers` is logged and drops this one socket;
  // unwrapped, socket.io's nextTick connect would make it an uncaughtException.
  onConnection(io, attachHandlers);
  // #622 — with the cluster adapter, a revocation or eviction handled on another
  // replica moves THIS replica's #613 epochs too, so a handshake or
  // `subscribe:mcp` in flight here re-reads; a role-change reconnect also closes
  // this replica's transports (see `reconnectUserSockets`).
  wireUserRevocationRelay(io, Boolean(opts.adapter));
  wireMcpStatusEvictionRelay(io, Boolean(opts.adapter));
  opts.onAdapterListening?.(() =>
    runDetached(revalidateLocalSockets(io, "listen"), "revalidateLocalSockets listen"),
  );
  const sweepEvery =
    opts.revalidateIntervalMs ?? (opts.adapter ? resolveSocketRevalidateIntervalMs() : undefined);
  if (sweepEvery !== undefined) {
    const sweep = setInterval(
      () => runDetached(revalidateLocalSockets(io, "sweep"), "revalidateLocalSockets sweep"),
      sweepEvery,
    );
    sweep.unref();
    // `io.close()` closes the HTTP server, which ends the sweep with it.
    // eslint-disable-next-line no-restricted-syntax -- #658: the HTTP server's own `close`, not a socket.io listener; no client reaches it and clearInterval cannot throw
    httpServer.once("close", () => clearInterval(sweep));
  }
  return io;
}

/**
 * #659 — the default re-validation sweep interval on a clustered server, and so
 * the documented bound on a revocation whose cross-replica publish failed:
 * every replica applies it from the database by the end of the first pass that
 * starts after the revocation committed. A tick that fires while a pass is
 * running only queues one more pass, so the worst case is this interval plus
 * the rest of the running pass plus one full pass: up to two passes on top of
 * the interval (`REVALIDATE_CONCURRENCY` users re-read at a time). The cost is
 * one pass per replica per interval: the handshake's live-identity read per
 * connected user (docs/EKS_DEPLOYMENT.md §9f.1). A user whose lookup fails in a
 * sweep-only pass keeps their sockets until a later pass reads them, so a
 * database outage extends the bound for that user by the outage.
 *
 * Overridden by `METIS_SOCKET_REVALIDATE_INTERVAL_MS`
 * (`resolveSocketRevalidateIntervalMs`).
 */
export const SOCKET_REVALIDATE_INTERVAL_MS = 60_000;

/** Smallest accepted `METIS_SOCKET_REVALIDATE_INTERVAL_MS`: 10 s. */
export const SOCKET_REVALIDATE_MIN_INTERVAL_MS = 10_000;

/**
 * #659 — the sweep interval from `METIS_SOCKET_REVALIDATE_INTERVAL_MS`: plain
 * decimal milliseconds from `SOCKET_REVALIDATE_MIN_INTERVAL_MS` to
 * `MAX_TIMEOUT_MS`. Unset or blank keeps `SOCKET_REVALIDATE_INTERVAL_MS`; any
 * other value keeps it too, with a warning naming the setting.
 */
export function resolveSocketRevalidateIntervalMs(): number {
  return envMs("METIS_SOCKET_REVALIDATE_INTERVAL_MS", SOCKET_REVALIDATE_INTERVAL_MS, {
    min: SOCKET_REVALIDATE_MIN_INTERVAL_MS,
    warning: "Ignoring invalid socket re-validation interval; keeping the 60 s default",
  });
}

/** Reject an explicit `revalidateIntervalMs` that Node would run as a ~1 ms timer. */
function assertRevalidateInterval(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `revalidateIntervalMs must be a positive number of milliseconds up to ${MAX_TIMEOUT_MS}; got ${ms}`,
    );
  }
}

/** Users re-read at once by `revalidateLocalSockets`, so a failover cannot flood the database pool. */
export const REVALIDATE_CONCURRENCY = 4;

/** Prefix of every `mcp:status` workspace room. */
const MCP_STATUS_WORKSPACE_ROOM_PREFIX = mcpStatusWorkspaceRoom("");

interface RevalidationState {
  /** Set by a call that arrived while this pass ran: run one more pass. */
  dirty: boolean;
  /** The trigger the next pass logs as: `listen` if any call it serves was one. */
  next: RevalidationTrigger;
  done: Promise<void>;
}

/** The `revalidateLocalSockets` pass in flight for each server, if any. */
const revalidations = new WeakMap<MetisIOServer, RevalidationState>();

/**
 * #649 — re-validate every socket connected to this replica against the
 * database, applying any revocation it missed while the cluster adapter's
 * `LISTEN` connection was down:
 *   - a user no longer live is disconnected, and a changed role re-handshakes
 *     (`applyLiveUser`, as #613's re-check);
 *   - a socket still in an `mcp:status` workspace room it no longer has a live
 *     membership of leaves it (#588).
 * What a failed lookup (either one) does depends on the trigger. A pass that
 * serves a `LISTEN` (re)connect fails closed: a publish may really have been
 * missed, so the transport closes and the client re-handshakes and
 * re-subscribes from live state. A sweep-only pass (#659) fails open: a lookup
 * failure on a tick is not evidence of revocation, and closing every socket a
 * database blip reaches would have them all reconnect at once against the same
 * database. It keeps the user's sockets, warns, and leaves the user to the next
 * pass.
 * Both #613 epochs are bumped first, so a handshake or `subscribe:mcp` in
 * flight re-reads too. Each user is read once, `REVALIDATE_CONCURRENCY` users
 * at a time. Never rejects.
 *
 * Single-flight per `io`: a call while a pass is running starts no second one.
 * It marks the pass dirty, and exactly one more full pass runs when it
 * finishes, which also sees a revocation committed after the running pass read
 * that user. A flapping `LISTEN` connection therefore never multiplies the read
 * bound. The returned promise settles once no pass is left to run.
 *
 * `trigger` sets how a failed lookup is handled (above) and how loudly a pass
 * is logged: a `LISTEN` (re)connect is rare and worth an info line, the #659
 * periodic sweep is not. A pass that serves both a sweep and a `LISTEN` signal
 * runs as `listen`, so it fails closed.
 */
export function revalidateLocalSockets(
  io: MetisIOServer,
  trigger: RevalidationTrigger = "listen",
): Promise<void> {
  const running = revalidations.get(io);
  if (running) {
    running.dirty = true;
    running.next = running.next === "listen" ? "listen" : trigger;
    return running.done;
  }
  const state: RevalidationState = { dirty: false, next: trigger, done: Promise.resolve() };
  revalidations.set(io, state);
  state.done = (async () => {
    try {
      do {
        const pass = state.next;
        state.dirty = false;
        state.next = "sweep";
        await revalidateOnce(io, pass);
      } while (state.dirty);
    } finally {
      revalidations.delete(io);
    }
  })();
  return state.done;
}

/** What started a `revalidateLocalSockets` pass. */
export type RevalidationTrigger = "listen" | "sweep";

/** One full `revalidateLocalSockets` pass. */
async function revalidateOnce(io: MetisIOServer, trigger: RevalidationTrigger): Promise<void> {
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
  if (trigger === "listen") {
    log.info(
      "Re-validating sockets after the cluster adapter's LISTEN connection was (re)established",
      { users: byUser.size },
    );
  } else {
    log.debug("Periodic socket re-validation sweep", { users: byUser.size });
  }
  const queue = [...byUser.values()];
  const worker = async (): Promise<void> => {
    for (let sockets = queue.shift(); sockets; sockets = queue.shift()) {
      await revalidateUserSockets(sockets, trigger);
    }
  };
  await Promise.all(Array.from({ length: REVALIDATE_CONCURRENCY }, worker));
}

/**
 * Re-validate one user's sockets (`revalidateLocalSockets`). On a failed
 * lookup, a `listen` pass closes the transports and a `sweep` pass keeps them.
 */
async function revalidateUserSockets(
  sockets: MetisSocket[],
  trigger: RevalidationTrigger,
): Promise<void> {
  const userId = sockets[0].data.user.userId;
  const failClosed = trigger === "listen";
  let live: AuthPayload | null | undefined;
  try {
    live = await loadLiveAuthPayload(userId);
  } catch (err) {
    if (!failClosed) {
      log.warn(
        "Socket re-validation sweep: live-user lookup failed — keeping sockets until the next pass",
        { userId, error: (err as Error).message },
      );
      return;
    }
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
    if (!failClosed) {
      log.warn(
        "Socket re-validation sweep: membership lookup failed — keeping workspace rooms until the next pass",
        { userId, error: (err as Error).message },
      );
      return;
    }
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
      if (!allowed.has(room)) runDetached(socket.leave(room), "revalidate leave", socket.id);
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
  runDetached(socket.join(`user:${user.userId}`), "join user room", socket.id);
  log.debug("Socket auto-joined personal room", {
    socketId: socket.id,
    room: `user:${user.userId}`,
  });
  // #613 — a role change or deprovision that committed after the handshake read
  // the live user, but whose `reconnectUserSockets` / `disconnectUserSockets`
  // ran before the join above, found no socket in `user:{id}` and missed this
  // one. Any such revocation moved the epoch, so re-read the user once.
  if (userSocketRevocationEpoch(socket.nsp.server) !== socket.data.revocationEpoch) {
    runDetached(recheckLiveUser(socket), "recheckLiveUser", socket.id);
  }

  // #654 — no handler destructures its payload in the parameter list: a null or
  // missing payload threw inside socket.io's nextTick dispatch, an uncaught
  // exception that took the whole API process down. Each reads its field with
  // `?.` and ignores anything that is not a non-empty string.
  onClientEvent(socket, "subscribe:project", (payload) => {
    const projectId: unknown = payload?.projectId;
    if (!projectId || typeof projectId !== "string") return;
    // #255 — per-project authorization. The `project:{id}` room fans out
    // job-lifecycle, presence, and comment events; an authenticated client must
    // not be able to subscribe to a project it has no access to (OWASP A01,
    // broken access control). Mirror the route-layer project-scoping used by
    // epics #207/#208 via the shared `actorCanAccessProject` helper, which also
    // emits an audit row on denial. Admins pass; non-members are rejected and
    // never join the room (so they receive no events).
    return (async () => {
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
  onClientEvent(socket, "unsubscribe:project", (payload) => {
    const projectId: unknown = payload?.projectId;
    if (!projectId || typeof projectId !== "string") return;
    return socket.leave(`project:${projectId}`);
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
  onClientEvent(socket, "subscribe:analysis", (payload) => {
    const analysisId: unknown = payload?.analysisId;
    if (!analysisId || typeof analysisId !== "string") return;
    const attempt = bumpAnalysisSubscription(analysisId);
    return (async () => {
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
  onClientEvent(socket, "unsubscribe:analysis", (payload) => {
    const analysisId: unknown = payload?.analysisId;
    if (!analysisId || typeof analysisId !== "string") return;
    bumpAnalysisSubscription(analysisId);
    return socket.leave(`analysis:${analysisId}`);
  });
  // #142 — the session room now carries tool-approval prompts (with the tool's
  // arguments), so only the session's owner, who can still reach its project,
  // may join it — the same rule as every other read of the session. It used to
  // join any id a client named.
  onClientEvent(socket, "subscribe:session", (payload) => {
    const sessionId: unknown = payload?.sessionId;
    if (!sessionId || typeof sessionId !== "string") return;
    return (async () => {
      try {
        await loadAuthorizedSession(user, sessionId);
        await socket.join(`session:${sessionId}`);
      } catch {
        socket.emit("auth:error", { message: "FORBIDDEN: no access to session" });
      }
    })();
  });
  onClientEvent(socket, "unsubscribe:session", (payload) => {
    const sessionId: unknown = payload?.sessionId;
    if (!sessionId || typeof sessionId !== "string") return;
    return socket.leave(`session:${sessionId}`);
  });
  // #562 — bumped by every subscribe/unsubscribe, so a subscribe whose
  // membership lookup resolves after a later unsubscribe does not join.
  let mcpSubscription = 0;
  onClientEvent(socket, "subscribe:mcp", () => {
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
        if (isMcpStatusRoom(room) && !rooms.includes(room)) {
          runDetached(socket.leave(room), "subscribe:mcp leave", socket.id);
        }
      }
    };
    return (async () => {
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
  onClientEvent(socket, "unsubscribe:mcp", () => {
    ++mcpSubscription;
    // Every mcp:status room this socket is in, whatever memberships it joined.
    for (const room of [...socket.rooms]) {
      if (isMcpStatusRoom(room))
        runDetached(socket.leave(room), "unsubscribe:mcp leave", socket.id);
    }
  });

  onClientEvent(socket, "subscribe:connector", (payload) => {
    const connectorId: unknown = payload?.connectorId;
    if (!connectorId || typeof connectorId !== "string") return;
    return socket.join(`connector:${connectorId}`);
  });
  onClientEvent(socket, "unsubscribe:connector", (payload) => {
    const connectorId: unknown = payload?.connectorId;
    if (!connectorId || typeof connectorId !== "string") return;
    return socket.leave(`connector:${connectorId}`);
  });

  onClientEvent(socket, "subscribe:publish", (payload) => {
    const batchId: unknown = payload?.batchId;
    if (!batchId || typeof batchId !== "string") return;
    if (!hasPermission(user.role, "issue.publish") && !hasPermission(user.role, "issue.preview")) {
      socket.emit("auth:error", { message: "FORBIDDEN" });
      return;
    }
    return socket.join(`publish:${batchId}`);
  });
  onClientEvent(socket, "unsubscribe:publish", (payload) => {
    const batchId: unknown = payload?.batchId;
    if (!batchId || typeof batchId !== "string") return;
    return socket.leave(`publish:${batchId}`);
  });

  // Phase 11 — scheduler + tasks rooms.
  onClientEvent(socket, "subscribe:scheduler", () => {
    if (!hasPermission(user.role, "scheduler.read")) {
      socket.emit("auth:error", {
        message: "FORBIDDEN: subscribe:scheduler requires scheduler.read",
      });
      return;
    }
    return socket.join("scheduler:status");
  });
  onClientEvent(socket, "unsubscribe:scheduler", () => {
    return socket.leave("scheduler:status");
  });
  onClientEvent(socket, "subscribe:task", (payload) => {
    const taskId: unknown = payload?.taskId;
    if (!taskId || typeof taskId !== "string") return;
    if (!hasPermission(user.role, "task.read")) {
      socket.emit("auth:error", { message: "FORBIDDEN: subscribe:task requires task.read" });
      return;
    }
    return socket.join(`task:${taskId}`);
  });
  onClientEvent(socket, "unsubscribe:task", (payload) => {
    const taskId: unknown = payload?.taskId;
    if (!taskId || typeof taskId !== "string") return;
    return socket.leave(`task:${taskId}`);
  });

  // Epic #238 (#239) — unified job-lifecycle rooms (`job:{jobId}`).
  // Analysis, doc-generation, and impact-analysis all broadcast here. Anyone
  // with a job id (returned from the trigger endpoint) may subscribe; finer
  // authz is enforced at the REST trigger layer that hands out the id.
  onClientEvent(socket, "subscribe:job", (payload) => {
    const jobId: unknown = payload?.jobId;
    if (!jobId || typeof jobId !== "string") return;
    runDetached(socket.join(`job:${jobId}`), "subscribe:job join", socket.id);
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
    return (async () => {
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
  onClientEvent(socket, "unsubscribe:job", (payload) => {
    const jobId: unknown = payload?.jobId;
    if (!jobId || typeof jobId !== "string") return;
    return socket.leave(`job:${jobId}`);
  });

  // Epic #156 — async background run rooms (`run:{runId}`).
  onClientEvent(socket, "subscribe:bg-run", (payload) => {
    const runId: unknown = payload?.runId;
    if (!runId || typeof runId !== "string") return;
    return socket.join(`run:${runId}`);
  });
  onClientEvent(socket, "unsubscribe:bg-run", (payload) => {
    const runId: unknown = payload?.runId;
    if (!runId || typeof runId !== "string") return;
    return socket.leave(`run:${runId}`);
  });

  onClientEvent(socket, "disconnect", (reason) => {
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
  onClientEvent(socket, "disconnect", () => clearInterval(heartbeat));
}
