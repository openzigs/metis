/**
 * #682 — the token-bucket rate limit on Socket.IO room joins.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", () => ({
  createChildLogger: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  DEFAULT_JOIN_RATE_LIMITS,
  JOIN_RATE_LIMITED,
  JoinRateLimiter,
  MAX_RETRY_AFTER_MS,
  REFUSAL_LOG_INTERVAL_MS,
  getJoinRateLimiter,
  onRoomJoin,
  resolveJoinRateLimits,
  roomFromField,
  setJoinRateLimiter,
  type JoinRateLimitConfig,
} from "./join-rate-limit.js";

/** A limiter driven by a hand-moved clock. */
function clocked(config: JoinRateLimitConfig) {
  const clock = { t: 1_000_000 };
  return { clock, limiter: new JoinRateLimiter(config, () => clock.t) };
}

const small: JoinRateLimitConfig = {
  socket: { burst: 3, perSecond: 1 },
  user: { burst: 5, perSecond: 1 },
};

/** Take until refused; returns how many were admitted (capped at `max`). */
function drain(limiter: JoinRateLimiter, socket: object, userId: string, max = 1000): number {
  let n = 0;
  while (n < max && limiter.tryTake(socket, userId)) n++;
  return n;
}

afterEach(() => {
  setJoinRateLimiter(undefined);
  warn.mockReset();
});

describe("resolveJoinRateLimits", () => {
  it("uses the defaults when nothing is set", () => {
    expect(resolveJoinRateLimits({})).toEqual(DEFAULT_JOIN_RATE_LIMITS);
  });

  it("reads every override from the environment", () => {
    expect(
      resolveJoinRateLimits({
        METIS_SOCKET_JOIN_RATE_LIMIT_BURST: "7",
        METIS_SOCKET_JOIN_RATE_LIMIT_PER_SEC: "0.5",
        METIS_SOCKET_JOIN_USER_RATE_LIMIT_BURST: "70",
        METIS_SOCKET_JOIN_USER_RATE_LIMIT_PER_SEC: "2",
      }),
    ).toEqual({ socket: { burst: 7, perSecond: 0.5 }, user: { burst: 70, perSecond: 2 } });
  });

  it.each(["0", "-1", "abc", "Infinity"])("ignores %s with a warning", (raw) => {
    expect(resolveJoinRateLimits({ METIS_SOCKET_JOIN_RATE_LIMIT_BURST: raw }).socket.burst).toBe(
      DEFAULT_JOIN_RATE_LIMITS.socket.burst,
    );
    expect(warn).toHaveBeenCalledWith(
      "Ignoring invalid socket join rate-limit setting",
      expect.objectContaining({ name: "METIS_SOCKET_JOIN_RATE_LIMIT_BURST", value: raw }),
    );
  });

  it.each([
    ["METIS_SOCKET_JOIN_RATE_LIMIT_BURST", "socket"],
    ["METIS_SOCKET_JOIN_USER_RATE_LIMIT_BURST", "user"],
  ] as const)("ignores a fractional %s below 1, which would refuse every join", (name, scope) => {
    const limits = resolveJoinRateLimits({ [name]: "0.5" });
    expect(limits[scope].burst).toBe(DEFAULT_JOIN_RATE_LIMITS[scope].burst);
    expect(warn).toHaveBeenCalledWith(
      "Ignoring invalid socket join rate-limit setting",
      expect.objectContaining({ name, value: "0.5" }),
    );
    // A burst of exactly 1 is the smallest that can ever admit a join.
    expect(resolveJoinRateLimits({ [name]: "1" })[scope].burst).toBe(1);
  });

  it("keeps the per-user refill low enough to bound a probe loop's audit rows", () => {
    // 5 admitted joins a second is 18,000 audit rows an hour per user per replica.
    expect(DEFAULT_JOIN_RATE_LIMITS.user).toEqual({ burst: 300, perSecond: 5 });
  });

  it("treats a blank value as unset", () => {
    expect(
      resolveJoinRateLimits({ METIS_SOCKET_JOIN_RATE_LIMIT_PER_SEC: " " }).socket.perSecond,
    ).toBe(DEFAULT_JOIN_RATE_LIMITS.socket.perSecond);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("JoinRateLimiter", () => {
  it("refuses a burst over the socket's limit", () => {
    const { limiter } = clocked(small);
    expect(drain(limiter, {}, "u1")).toBe(3);
  });

  it("refills the bucket over time, up to the burst and no further", () => {
    const { clock, limiter } = clocked(small);
    const socket = {};
    drain(limiter, socket, "u1");
    clock.t += 1000;
    expect(drain(limiter, socket, "u1")).toBe(1);
    clock.t += 1500;
    expect(drain(limiter, socket, "u1")).toBe(1); // 1.5 tokens → one whole one
    clock.t += 500;
    expect(drain(limiter, socket, "u1")).toBe(1); // the half left over plus half
    clock.t += 60_000; // capped at the user bucket's remaining refill, not 60
    expect(drain(limiter, socket, "u1")).toBe(3);
  });

  it("shares one user bucket across that user's sockets", () => {
    const { limiter } = clocked(small);
    expect(drain(limiter, {}, "u1")).toBe(3);
    expect(drain(limiter, {}, "u1")).toBe(2); // the user's 5, not another 3
    expect(drain(limiter, {}, "u2")).toBe(3); // another user is unaffected
  });

  it("takes nothing from the user bucket on a join the socket bucket refuses", () => {
    const { limiter } = clocked(small);
    const first = {};
    drain(limiter, first, "u1"); // socket 3, user 5 → 2 left
    for (let i = 0; i < 10; i++) limiter.tryTake(first, "u1");
    expect(drain(limiter, {}, "u1")).toBe(2);
  });

  it("names the wait until the emptier bucket holds a whole token", () => {
    const { clock, limiter } = clocked({
      socket: { burst: 2, perSecond: 4 },
      user: { burst: 3, perSecond: 0.5 },
    });
    const socket = {};
    expect(limiter.take(socket, "u1")).toBe(0);
    expect(limiter.take(socket, "u1")).toBe(0);
    // Socket empty (4/s → 250 ms), user holds 1.
    expect(limiter.take(socket, "u1")).toBe(250);
    clock.t += 125; // socket 0.5 → 125 ms left
    expect(limiter.take(socket, "u1")).toBe(125);
    clock.t += 125;
    expect(limiter.take(socket, "u1")).toBe(0); // user now 0.125 (0.5/s)
    clock.t += 250; // socket 1 again, user 0.25 → 1,500 ms
    expect(limiter.take(socket, "u1")).toBe(1500);
  });

  it(`caps the named wait at ${MAX_RETRY_AFTER_MS} ms`, () => {
    const { limiter } = clocked({
      socket: { burst: 1, perSecond: 1e-9 },
      user: { burst: 1, perSecond: 1e-9 },
    });
    limiter.take({}, "u1");
    expect(limiter.take({}, "u1")).toBe(MAX_RETRY_AFTER_MS);
  });

  it("does not go backwards when the clock does", () => {
    const { clock, limiter } = clocked(small);
    const socket = {};
    drain(limiter, socket, "u1");
    clock.t -= 10_000;
    expect(limiter.tryTake(socket, "u1")).toBe(false);
  });

  it("admits a reconnect re-subscribe burst of a page with many rooms by default", () => {
    const { limiter } = clocked(DEFAULT_JOIN_RATE_LIMITS);
    // The presence cap alone is 50 rooms per socket; add the page's other rooms.
    const socket = {};
    for (let i = 0; i < 80; i++) expect(limiter.tryTake(socket, "u1")).toBe(true);
    // Two tabs reconnecting together, as the same user, also fit.
    for (let i = 0; i < 80; i++) expect(limiter.tryTake({}, "u1")).toBe(true);
  });

  it("sweeps full user buckets once the map has grown, keeping drained ones", () => {
    const { clock, limiter } = clocked(small);
    const socket = {};
    drain(limiter, socket, "drained");
    // 1,024 buckets in all: the sweep floor, reached without a sweep running.
    for (let i = 0; i < 1023; i++) limiter.tryTake({}, `u${i}`);
    // Each of those took a token; let every bucket but `drained`'s refill fully.
    clock.t += 2000;
    for (let i = 0; i < 4; i++) limiter.tryTake({}, "drained"); // refilled to 4; empty it
    const before = limiter.userBucketCount;
    expect(before).toBe(1024);
    limiter.tryTake({}, "newcomer"); // a new user bucket triggers the sweep
    expect(limiter.userBucketCount).toBe(2); // `drained` and `newcomer`
    expect(limiter.tryTake({}, "drained")).toBe(false);
    // Nothing more is swept until the map reaches the floor again.
    for (let i = 0; i < 1021; i++) limiter.tryTake({}, `v${i}`);
    clock.t += 10_000;
    limiter.tryTake({}, "one-more");
    expect(limiter.userBucketCount).toBe(1024);
    limiter.tryTake({}, "trigger");
    // Every bucket refilled in the 10s, except `one-more`, which took a token since.
    expect(limiter.userBucketCount).toBe(2);
  });
});

describe("getJoinRateLimiter", () => {
  it("builds the limiter from the environment once and reuses it", () => {
    vi.stubEnv("METIS_SOCKET_JOIN_RATE_LIMIT_BURST", "9");
    try {
      const first = getJoinRateLimiter();
      expect(first.config.socket.burst).toBe(9);
      expect(getJoinRateLimiter()).toBe(first);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("roomFromField", () => {
  const roomOf = roomFromField("jobId", (id) => `job:${id}`);
  it("names the room for a non-empty string id", () => {
    expect(roomOf({ jobId: "j1" })).toBe("job:j1");
  });
  it.each([[undefined], [null], [42], [{}], [{ jobId: "" }], [{ jobId: 7 }]])(
    "returns undefined for %j",
    (payload) => {
      expect(roomOf(payload)).toBeUndefined();
    },
  );
});

describe("onRoomJoin", () => {
  function fakeSocket(userId = "u1") {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const emit = vi.fn();
    const socket = {
      id: `s-${Math.random()}`,
      data: { user: { userId } },
      emit,
      on: ((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }) as never,
    };
    return {
      socket,
      emit,
      fire: (event: string, payload: unknown) => handlers.get(event)!(payload),
    };
  }

  it("runs the handler while tokens last, then answers with a room-scoped refusal", async () => {
    setJoinRateLimiter(clocked(small).limiter);
    const { socket, emit, fire } = fakeSocket();
    const handler = vi.fn();
    onRoomJoin(
      socket,
      "subscribe:job",
      roomFromField("jobId", (id) => `job:${id}`),
      handler,
    );
    for (let i = 0; i < 5; i++) await fire("subscribe:job", { jobId: `j${i}` });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(emit.mock.calls).toEqual([
      [
        "auth:error",
        { message: JOIN_RATE_LIMITED, room: "job:j3", code: "RATE_LIMITED", retryAfterMs: 1000 },
      ],
      [
        "auth:error",
        { message: JOIN_RATE_LIMITED, room: "job:j4", code: "RATE_LIMITED", retryAfterMs: 1000 },
      ],
    ]);
  });

  it("charges nothing for a payload the handler ignores", async () => {
    setJoinRateLimiter(clocked(small).limiter);
    const { socket, emit, fire } = fakeSocket();
    const handler = vi.fn();
    onRoomJoin(
      socket,
      "subscribe:job",
      roomFromField("jobId", (id) => `job:${id}`),
      handler,
    );
    for (let i = 0; i < 10; i++) await fire("subscribe:job", null);
    for (let i = 0; i < 3; i++) await fire("subscribe:job", { jobId: "j" });
    expect(handler).toHaveBeenCalledTimes(13);
    expect(emit).not.toHaveBeenCalled();
  });

  it("logs a socket's refusals at most once per interval, across its join events", async () => {
    const { clock, limiter } = clocked(small);
    setJoinRateLimiter(limiter);
    const { socket, fire } = fakeSocket();
    onRoomJoin(socket, "subscribe:task", () => "task:t", vi.fn());
    onRoomJoin(socket, "subscribe:job", () => "job:j", vi.fn());
    for (let i = 0; i < 10; i++) await fire("subscribe:task", { taskId: "t" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Socket room join rate-limited",
      expect.objectContaining({
        userId: "u1",
        event: "subscribe:task",
        room: "task:t",
        suppressedSinceLastLog: 0,
      }),
    );
    // Refill admits joins between refusals: re-arming on an admitted join would
    // log at the refill rate. Within the interval nothing more is logged.
    for (let s = 0; s < 30; s++) {
      clock.t += 1000;
      await fire("subscribe:job", { jobId: "j" }); // admitted
      await fire("subscribe:job", { jobId: "j" }); // refused
    }
    expect(clock.t - 1_000_000).toBeLessThan(REFUSAL_LOG_INTERVAL_MS);
    expect(warn).toHaveBeenCalledTimes(1);
    clock.t += REFUSAL_LOG_INTERVAL_MS;
    await fire("subscribe:job", { jobId: "j" }); // admitted after the refill
    for (let i = 0; i < 5; i++) await fire("subscribe:job", { jobId: "j" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      "Socket room join rate-limited",
      expect.objectContaining({ event: "subscribe:job", suppressedSinceLastLog: 36 }),
    );
    // Another socket is logged on its own interval.
    const other = fakeSocket("u2");
    onRoomJoin(other.socket, "subscribe:job", () => "job:j", vi.fn());
    for (let i = 0; i < 4; i++) await other.fire("subscribe:job", { jobId: "j" });
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
