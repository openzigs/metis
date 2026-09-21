/**
 * Epic #547 (Phase 4, #554) — inbound bridge rate-limit tests.
 *
 * Caps how many inbound Teams activities a single (workspace, conversation) can
 * push through the bridge per window, so a chatty/abusive channel cannot flood
 * METIS with DiscussionMessages (DoS / cost abuse — OWASP A04). Reuses the shared
 * RateLimitStore seam (#508/#541), so the cap can hold cluster-wide via Postgres.
 *
 * Deterministic via an injected `now` (no fake timers needed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkInboundRateLimit,
  loadInboundRateLimitConfig,
  __resetInboundRateLimiter,
  __setInboundRateLimitStore,
} from "./inbound-rate-limit.js";
import type { RateLimitStore } from "../discussions/rate-limit-store.js";

beforeEach(() => __resetInboundRateLimiter());
afterEach(() => {
  delete process.env.TEAMS_INBOUND_RATE_LIMIT_MAX;
  delete process.env.TEAMS_INBOUND_RATE_LIMIT_WINDOW_MS;
  __resetInboundRateLimiter();
});

describe("loadInboundRateLimitConfig", () => {
  it("uses documented defaults when env is unset", () => {
    const cfg = loadInboundRateLimitConfig({});
    expect(cfg.max).toBe(30);
    expect(cfg.windowMs).toBe(60_000);
  });

  it("honours env overrides", () => {
    const cfg = loadInboundRateLimitConfig({
      TEAMS_INBOUND_RATE_LIMIT_MAX: "5",
      TEAMS_INBOUND_RATE_LIMIT_WINDOW_MS: "10000",
    });
    expect(cfg.max).toBe(5);
    expect(cfg.windowMs).toBe(10_000);
  });

  it("falls back to defaults on invalid/negative values", () => {
    const cfg = loadInboundRateLimitConfig({
      TEAMS_INBOUND_RATE_LIMIT_MAX: "-3",
      TEAMS_INBOUND_RATE_LIMIT_WINDOW_MS: "abc",
    });
    expect(cfg.max).toBe(30);
    expect(cfg.windowMs).toBe(60_000);
  });
});

describe("checkInboundRateLimit", () => {
  const key = { workspaceId: "ws-1", conversationId: "convo-1" };
  const cfg = { max: 3, windowMs: 60_000 };

  it("allows hits up to the cap then denies", async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const r = await checkInboundRateLimit(key, cfg, t0 + i);
      expect(r.allowed).toBe(true);
    }
    const denied = await checkInboundRateLimit(key, cfg, t0 + 3);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.limit).toBe(3);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
    }
  });

  it("frees a slot once the oldest hit ages out of the window", async () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 3; i++) await checkInboundRateLimit(key, cfg, t0 + i);
    // Just inside the window → still denied.
    expect((await checkInboundRateLimit(key, cfg, t0 + 100)).allowed).toBe(false);
    // After the window fully passes the first hit → allowed again.
    const after = await checkInboundRateLimit(key, cfg, t0 + cfg.windowMs + 1);
    expect(after.allowed).toBe(true);
  });

  it("isolates separate conversations (one chatty channel does not starve another)", async () => {
    const t0 = 3_000_000;
    for (let i = 0; i < 3; i++) await checkInboundRateLimit(key, cfg, t0 + i);
    expect((await checkInboundRateLimit(key, cfg, t0 + 3)).allowed).toBe(false);

    const other = { workspaceId: "ws-1", conversationId: "convo-2" };
    expect((await checkInboundRateLimit(other, cfg, t0 + 3)).allowed).toBe(true);
  });

  it("isolates the same conversation id across different workspaces", async () => {
    const t0 = 4_000_000;
    const a = { workspaceId: "ws-a", conversationId: "shared" };
    const b = { workspaceId: "ws-b", conversationId: "shared" };
    for (let i = 0; i < 3; i++) await checkInboundRateLimit(a, cfg, t0 + i);
    expect((await checkInboundRateLimit(a, cfg, t0 + 3)).allowed).toBe(false);
    expect((await checkInboundRateLimit(b, cfg, t0 + 3)).allowed).toBe(true);
  });

  it("uses an injected store (the cross-instance / cluster seam)", async () => {
    const hit = vi
      .fn<RateLimitStore["hit"]>()
      .mockResolvedValue({ allowed: false, recentCount: 99, oldestTs: 1_000 });
    const fake: RateLimitStore = { hit, reset: vi.fn(async () => {}) };
    const prev = __setInboundRateLimitStore(fake);
    try {
      const r = await checkInboundRateLimit(key, cfg, 2_000);
      expect(r.allowed).toBe(false);
      expect(hit).toHaveBeenCalledTimes(1);
      // key carries the teams-inbound namespace prefix (no collision with AI cap).
      expect((hit.mock.calls[0][0] as string).startsWith("teams-inbound:")).toBe(true);
    } finally {
      __setInboundRateLimitStore(prev);
    }
  });
});
