/**
 * Epic #475 (Phase 3, #485) → #541 — per-thread/per-user AI-invocation rate
 * limit tests.
 *
 * Discussion AI replies are gated by a windowed limiter keyed by (threadId,
 * userId). Exceeding the limit returns a deny WITHOUT invoking the provider, so
 * a chatty/abusive thread cannot run up unbounded LLM cost. Human↔human messages
 * never reach this limiter (they don't invoke AI), so they are never
 * rate-limited. The check is async (#541) because the production backend is the
 * shared Postgres store.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  checkThreadAIRateLimit,
  __resetThreadAIRateLimiter,
  __setThreadAIRateLimitStore,
  loadThreadAIRateLimitConfig,
} from "./ai-rate-limit.js";
import { InMemoryRateLimitStore, SharedRateLimitStore } from "./rate-limit-store.js";

describe("loadThreadAIRateLimitConfig", () => {
  it("defaults to a sane window + max", () => {
    const cfg = loadThreadAIRateLimitConfig({});
    expect(cfg.max).toBeGreaterThan(0);
    expect(cfg.windowMs).toBeGreaterThan(0);
  });

  it("is overridable via env", () => {
    const cfg = loadThreadAIRateLimitConfig({
      DISCUSSION_AI_RATE_LIMIT_MAX: "3",
      DISCUSSION_AI_RATE_LIMIT_WINDOW_MS: "60000",
    });
    expect(cfg).toMatchObject({ max: 3, windowMs: 60_000 });
  });

  it("falls back to defaults for invalid env values", () => {
    const cfg = loadThreadAIRateLimitConfig({
      DISCUSSION_AI_RATE_LIMIT_MAX: "nope",
      DISCUSSION_AI_RATE_LIMIT_WINDOW_MS: "-5",
    });
    expect(cfg.max).toBeGreaterThan(0);
    expect(cfg.windowMs).toBeGreaterThan(0);
  });
});

describe("checkThreadAIRateLimit", () => {
  beforeEach(() => {
    __resetThreadAIRateLimiter();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const cfg = { max: 2, windowMs: 1000 };

  it("allows invocations under the limit", async () => {
    expect(await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg)).toMatchObject({
      allowed: true,
    });
    expect(await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg)).toMatchObject({
      allowed: true,
    });
  });

  it("blocks the invocation that exceeds the limit and reports retryAfterMs", async () => {
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg);
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg);
    const third = await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg);
    expect(third.allowed).toBe(false);
    if (!third.allowed) {
      expect(third.retryAfterMs).toBeGreaterThan(0);
      expect(third.limit).toBe(2);
    }
  });

  it("scopes the limit per (thread, user) — a different user in the same thread is independent", async () => {
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg);
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg);
    expect((await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg)).allowed).toBe(
      false,
    );
    expect((await checkThreadAIRateLimit({ threadId: "t1", userId: "u2" }, cfg)).allowed).toBe(
      true,
    );
  });

  it("scopes the limit per thread — the same user in another thread is independent", async () => {
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg);
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg);
    expect((await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg)).allowed).toBe(
      false,
    );
    expect((await checkThreadAIRateLimit({ threadId: "t2", userId: "u1" }, cfg)).allowed).toBe(
      true,
    );
  });

  it("resets after the window elapses (sliding window)", async () => {
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg);
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg);
    expect((await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg)).allowed).toBe(
      false,
    );

    vi.advanceTimersByTime(1001);
    expect((await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg)).allowed).toBe(
      true,
    );
  });

  it("partially restores budget as individual timestamps age out", async () => {
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg); // t=0
    vi.advanceTimersByTime(600);
    await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg); // t=600
    expect((await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg)).allowed).toBe(
      false,
    ); // 2 in window
    vi.advanceTimersByTime(500); // now t=1100; window covers (100, 1100]
    expect((await checkThreadAIRateLimit({ threadId: "t1", userId: "u1" }, cfg)).allowed).toBe(
      true,
    );
  });
});

/**
 * #508 → #541 — the AI-invocation cap holds GLOBALLY when two simulated replicas
 * share one backing store, and the per-process default does NOT share.
 */
describe("checkThreadAIRateLimit — shared-store cross-instance enforcement", () => {
  const cfg = { max: 2, windowMs: 1000 };

  afterEach(() => {
    __resetThreadAIRateLimiter();
    vi.useRealTimers();
  });

  it("enforces the GLOBAL cap when two replicas share one store (not 2× the cap)", async () => {
    vi.useFakeTimers();
    const shared = new SharedRateLimitStore();

    // Replica A is the module-level limiter pointed at the shared store.
    __setThreadAIRateLimitStore(shared);
    const replicaA = (uid: string) => checkThreadAIRateLimit({ threadId: "t1", userId: uid }, cfg);
    // Replica B is a SECOND call site (a different process in prod) hitting the
    // SAME shared store directly.
    const replicaB = async (uid: string) =>
      (await shared.hit(`t1::${uid}`, cfg.max, cfg.windowMs, Date.now())).allowed;

    expect((await replicaA("u1")).allowed).toBe(true); // global count → 1
    expect(await replicaB("u1")).toBe(true); // global count → 2
    expect((await replicaA("u1")).allowed).toBe(false);
    expect(await replicaB("u1")).toBe(false);
  });

  it("two SEPARATE in-memory stores do NOT share — per-process limit is real", async () => {
    vi.useFakeTimers();
    const replicaA = new InMemoryRateLimitStore();
    const replicaB = new InMemoryRateLimitStore();
    const now = Date.now();
    expect((await replicaA.hit("t1::u1", cfg.max, cfg.windowMs, now)).allowed).toBe(true);
    expect((await replicaA.hit("t1::u1", cfg.max, cfg.windowMs, now)).allowed).toBe(true);
    expect((await replicaA.hit("t1::u1", cfg.max, cfg.windowMs, now)).allowed).toBe(false);
    // replicaB has its OWN budget — effective ceiling is 2× without a shared store.
    expect((await replicaB.hit("t1::u1", cfg.max, cfg.windowMs, now)).allowed).toBe(true);
    expect((await replicaB.hit("t1::u1", cfg.max, cfg.windowMs, now)).allowed).toBe(true);
  });
});
