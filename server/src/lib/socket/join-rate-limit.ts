/**
 * #682 — a token-bucket rate limit on Socket.IO room joins.
 *
 * Every `subscribe:*` and `presence:*join` handler pays a server-side cost on a
 * denied or unknown id: `canAccessThread` writes an `AuditLog` row on each
 * not-found or forbidden probe, an unknown `subscribe:job` id runs several
 * primary-key lookups, and the presence room cap bounds only concurrent joins,
 * not their rate. A signed-in client looping joins with random ids could write
 * unbounded audit rows and drive database load.
 *
 * Each join takes one token from TWO buckets: the socket's, and the user's on
 * this replica (so opening more sockets does not multiply the rate). A join
 * that finds either bucket empty is refused before its handler runs — no access
 * check, no lookup, no audit row — with the room-scoped `auth:error
 * { message, room }` the UI drops without a toast (`SocketAuthErrorEvent`).
 * Audit rows from a probe loop are therefore bounded by the user bucket: at
 * most `burst + perSecond × seconds`.
 *
 * The defaults admit a reconnect's re-subscribe burst from a page with many
 * rooms (the presence cap alone is 50 per socket), and refill fast enough that
 * ordinary navigation never drains them. Override with
 * `METIS_SOCKET_JOIN_RATE_LIMIT_BURST` / `METIS_SOCKET_JOIN_RATE_LIMIT_PER_SEC` (per socket)
 * and `METIS_SOCKET_JOIN_USER_RATE_LIMIT_BURST` / `METIS_SOCKET_JOIN_USER_RATE_LIMIT_PER_SEC`
 * (per user, per replica). A value that is not a positive number is ignored
 * with a warning.
 *
 * Unsubscribes and leaves are never limited: stopping listening must always
 * work, and it costs nothing.
 */
import type { SocketAuthErrorEvent } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import {
  onClientEvent,
  type ClientEventHandler,
  type ClientEventListeners,
  type ClientEventSocket,
} from "./client-event-handler.js";

const log = createChildLogger("socket:join-rate-limit");

export interface TokenBucketConfig {
  /** Tokens a full bucket holds: the largest burst admitted at once. */
  burst: number;
  /** Tokens added back per second, up to `burst`. */
  perSecond: number;
}

export interface JoinRateLimitConfig {
  socket: TokenBucketConfig;
  user: TokenBucketConfig;
}

export const DEFAULT_JOIN_RATE_LIMITS: JoinRateLimitConfig = {
  socket: { burst: 100, perSecond: 5 },
  user: { burst: 300, perSecond: 15 },
};

/** The refusal text; the `room` field is what keeps the UI from toasting it. */
export const JOIN_RATE_LIMITED = "RATE_LIMITED: too many room joins, try again shortly";

function positiveNumberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    log.warn("Ignoring invalid socket join rate-limit setting", { name, value: raw, fallback });
    return fallback;
  }
  return value;
}

/** Read the limits from `env`, falling back to {@link DEFAULT_JOIN_RATE_LIMITS}. */
export function resolveJoinRateLimits(env: NodeJS.ProcessEnv = process.env): JoinRateLimitConfig {
  const d = DEFAULT_JOIN_RATE_LIMITS;
  return {
    socket: {
      burst: positiveNumberEnv(env, "METIS_SOCKET_JOIN_RATE_LIMIT_BURST", d.socket.burst),
      perSecond: positiveNumberEnv(env, "METIS_SOCKET_JOIN_RATE_LIMIT_PER_SEC", d.socket.perSecond),
    },
    user: {
      burst: positiveNumberEnv(env, "METIS_SOCKET_JOIN_USER_RATE_LIMIT_BURST", d.user.burst),
      perSecond: positiveNumberEnv(
        env,
        "METIS_SOCKET_JOIN_USER_RATE_LIMIT_PER_SEC",
        d.user.perSecond,
      ),
    },
  };
}

interface Bucket {
  tokens: number;
  at: number;
}

/** Below this many user buckets no sweep runs. */
const USER_SWEEP_FLOOR = 1024;

export class JoinRateLimiter {
  /** Keyed by the socket object, so a bucket goes when its socket does. */
  private readonly sockets = new WeakMap<object, Bucket>();
  private readonly users = new Map<string, Bucket>();
  private nextSweepAt = USER_SWEEP_FLOOR;

  constructor(
    readonly config: JoinRateLimitConfig,
    private readonly now: () => number = Date.now,
  ) {}

  private refill(bucket: Bucket, cfg: TokenBucketConfig, at: number): void {
    const elapsed = Math.max(0, at - bucket.at) / 1000;
    bucket.tokens = Math.min(cfg.burst, bucket.tokens + elapsed * cfg.perSecond);
    bucket.at = at;
  }

  /**
   * Take one token from `socket`'s bucket and `userId`'s. Returns `false`,
   * taking nothing, when either has less than one token.
   */
  tryTake(socket: object, userId: string): boolean {
    const at = this.now();
    let socketBucket = this.sockets.get(socket);
    if (!socketBucket) {
      socketBucket = { tokens: this.config.socket.burst, at };
      this.sockets.set(socket, socketBucket);
    }
    let userBucket = this.users.get(userId);
    if (!userBucket) {
      this.sweepUsers(at);
      userBucket = { tokens: this.config.user.burst, at };
      this.users.set(userId, userBucket);
    }
    this.refill(socketBucket, this.config.socket, at);
    this.refill(userBucket, this.config.user, at);
    if (socketBucket.tokens < 1 || userBucket.tokens < 1) return false;
    socketBucket.tokens -= 1;
    userBucket.tokens -= 1;
    return true;
  }

  /**
   * A full user bucket is indistinguishable from a missing one, so dropping it
   * changes no decision; this keeps the map to users who joined recently.
   * Runs only once the map has doubled since the last sweep.
   */
  private sweepUsers(at: number): void {
    if (this.users.size < this.nextSweepAt) return;
    for (const [userId, bucket] of this.users) {
      this.refill(bucket, this.config.user, at);
      if (bucket.tokens >= this.config.user.burst) this.users.delete(userId);
    }
    this.nextSweepAt = Math.max(USER_SWEEP_FLOOR, this.users.size * 2);
  }

  /** Exposed for tests: how many user buckets are held. */
  get userBucketCount(): number {
    return this.users.size;
  }
}

let limiter: JoinRateLimiter | undefined;

/** The process-wide limiter, built from the environment on first use. */
export function getJoinRateLimiter(): JoinRateLimiter {
  limiter ??= new JoinRateLimiter(resolveJoinRateLimits());
  return limiter;
}

/**
 * Exposed for tests: replace the process-wide limiter, or drop it so the next
 * join re-reads the environment.
 */
export function setJoinRateLimiter(next?: JoinRateLimiter): void {
  limiter = next;
}

/** The client events that ask to join a room. */
export type RoomJoinEvent = Extract<
  keyof ClientEventListeners,
  `subscribe:${string}` | "presence:join" | "presence:thread:join"
>;

/** The socket surface a rate-limited join needs. */
export interface RoomJoinSocket extends ClientEventSocket {
  emit(event: "auth:error", data: SocketAuthErrorEvent): unknown;
  data: { user: { userId: string } };
}

/**
 * Register `handler` for the room-join `event` behind the join rate limit.
 * `roomOf` names the room the payload asks for, or returns `undefined` for a
 * payload the handler ignores anyway — that costs no token. A limited join is
 * answered with `auth:error { message: JOIN_RATE_LIMITED, room }` and its
 * handler does not run. The first refusal of a run is logged; the rest are not,
 * so a probe loop cannot flood the log either.
 */
export function onRoomJoin<E extends RoomJoinEvent>(
  socket: RoomJoinSocket,
  event: E,
  roomOf: (...args: Parameters<ClientEventListeners[E]>) => string | undefined,
  handler: ClientEventHandler<E>,
): void {
  let limited = false;
  onClientEvent(socket, event, ((...args: Parameters<ClientEventListeners[E]>) => {
    const room = roomOf(...args);
    if (room !== undefined) {
      const { userId } = socket.data.user;
      if (!getJoinRateLimiter().tryTake(socket, userId)) {
        if (!limited) {
          limited = true;
          log.warn("Socket room join rate-limited", { socketId: socket.id, userId, event, room });
        }
        socket.emit("auth:error", { message: JOIN_RATE_LIMITED, room });
        return undefined;
      }
      limited = false;
    }
    return handler(...args);
  }) as ClientEventHandler<E>);
}

/** `roomOf` helper: `factory(payload[field])` when that is a non-empty string. */
export function roomFromField<K extends string>(
  field: K,
  factory: (id: string) => string,
): (payload?: unknown) => string | undefined {
  return (payload) => {
    const id: unknown = (payload as Record<string, unknown> | null | undefined)?.[field];
    return typeof id === "string" && id !== "" ? factory(id) : undefined;
  };
}
