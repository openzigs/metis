/**
 * Octokit factory + throttle hooks + auth scope verifier — Phase 9 (#66).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  makePinnedLookup: vi.fn(() => undefined),
}));

import {
  __resetPublishOctokitCache,
  __resetThrottleBudget,
  __setPublishOctokitFactory,
  __setThrottleSleep,
  acquirePublishOctokit,
  buildThrottleHooks,
  nextDelayMs,
  rateLimitConfigFromEnv,
  verifyAuthScope,
} from "../src/lib/publishing/octokit-factory.js";
import { PublishError } from "../src/lib/publishing/types.js";
import type { PublishOctokitLike } from "../src/lib/publishing/types.js";

afterEach(() => {
  __setPublishOctokitFactory(null);
  __resetPublishOctokitCache();
  vi.restoreAllMocks();
  delete process.env.PUBLISH_RATE_LIMIT_DELAY_MS;
  delete process.env.PUBLISH_RATE_LIMIT_JITTER_MS;
});

function fakeClient(impl: PublishOctokitLike["request"]): PublishOctokitLike {
  return { request: impl };
}

describe("rateLimitConfigFromEnv", () => {
  it("uses defaults when env unset", () => {
    const cfg = rateLimitConfigFromEnv();
    expect(cfg.delayMs).toBeGreaterThanOrEqual(1000);
    expect(cfg.maxRetries).toBeGreaterThanOrEqual(1);
  });

  it("honours custom env values", () => {
    process.env.PUBLISH_RATE_LIMIT_DELAY_MS = "1500";
    process.env.PUBLISH_RATE_LIMIT_JITTER_MS = "50";
    const cfg = rateLimitConfigFromEnv();
    expect(cfg.delayMs).toBe(1500);
    expect(cfg.jitterMs).toBe(50);
  });

  it("falls back to defaults on invalid values", () => {
    process.env.PUBLISH_RATE_LIMIT_DELAY_MS = "garbage";
    const cfg = rateLimitConfigFromEnv();
    expect(cfg.delayMs).toBe(1000);
  });
});

describe("nextDelayMs", () => {
  it("never returns negative", () => {
    const cfg = { ...rateLimitConfigFromEnv(), delayMs: 100, jitterMs: 500 };
    for (let i = 0; i < 100; i++) {
      expect(nextDelayMs(cfg)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildThrottleHooks", () => {
  it("primary hook honours retry budget", async () => {
    const cfg = { ...rateLimitConfigFromEnv(), maxRetries: 2 };
    const hooks = buildThrottleHooks(cfg);
    __setThrottleSleep(async () => undefined);
    expect(
      await hooks.onRateLimit(0, { request: { method: "POST", url: "/x" }, retryCount: 0 }),
    ).toBe(true);
    expect(
      await hooks.onRateLimit(0, { request: { method: "POST", url: "/x" }, retryCount: 2 }),
    ).toBe(false);
    __setThrottleSleep(null);
  });

  it("secondary hook honours retry budget", async () => {
    const cfg = { ...rateLimitConfigFromEnv(), maxRetries: 1 };
    const hooks = buildThrottleHooks(cfg);
    __setThrottleSleep(async () => undefined);
    __resetThrottleBudget(cfg);
    expect(
      await hooks.onSecondaryRateLimit(0, {
        request: { method: "POST", url: "/x" },
        retryCount: 0,
      }),
    ).toBe(true);
    expect(
      await hooks.onSecondaryRateLimit(0, {
        request: { method: "POST", url: "/x" },
        retryCount: 1,
      }),
    ).toBe(false);
    __setThrottleSleep(null);
  });

  it("F4: secondary hook actually awaits the computed backoff before retrying", async () => {
    const cfg = {
      ...rateLimitConfigFromEnv(),
      maxRetries: 3,
      secondaryBackoffBaseMs: 60_000,
      secondaryBackoffMaxMs: 600_000,
      backoffBudgetMs: 5 * 60_000,
    };
    const hooks = buildThrottleHooks(cfg);
    __resetThrottleBudget(cfg);
    const sleeps: number[] = [];
    __setThrottleSleep(async (ms) => {
      sleeps.push(ms);
    });
    // Header says 30s; computed jittered ceiling for retry 0 is up to 60s.
    const result = await hooks.onSecondaryRateLimit(30, {
      request: { method: "POST", url: "/x" },
      retryCount: 0,
    });
    expect(result).toBe(true);
    expect(sleeps.length).toBe(1);
    // header says 30s = 30_000ms — must sleep at LEAST that.
    expect(sleeps[0]).toBeGreaterThanOrEqual(30_000);
    __setThrottleSleep(null);
  });

  it("F4: secondary hook stops retrying when total backoff budget is exhausted", async () => {
    const cfg = {
      ...rateLimitConfigFromEnv(),
      maxRetries: 5,
      secondaryBackoffBaseMs: 60_000,
      secondaryBackoffMaxMs: 600_000,
      backoffBudgetMs: 1_000, // 1s total budget — first sleep blows it.
    };
    const hooks = buildThrottleHooks(cfg);
    __resetThrottleBudget(cfg);
    __setThrottleSleep(async () => undefined);
    const result = await hooks.onSecondaryRateLimit(120, {
      request: { method: "POST", url: "/x" },
      retryCount: 0,
    });
    expect(result).toBe(false);
    __setThrottleSleep(null);
  });
});

describe("acquirePublishOctokit caching", () => {
  it("returns the same client for the same (org, baseUrl, token)", async () => {
    let calls = 0;
    __setPublishOctokitFactory(async () => {
      calls += 1;
      return fakeClient(async () => ({ status: 200, headers: {}, data: {} }));
    });
    const a = await acquirePublishOctokit({
      owner: "acme",
      baseUrl: "https://api.github.com",
      token: "tok-1",
    });
    const b = await acquirePublishOctokit({
      owner: "acme",
      baseUrl: "https://api.github.com",
      token: "tok-1",
    });
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("rotates client on token change (fingerprint mismatch)", async () => {
    let calls = 0;
    __setPublishOctokitFactory(async () => {
      calls += 1;
      return fakeClient(async () => ({ status: 200, headers: {}, data: {} }));
    });
    await acquirePublishOctokit({
      owner: "acme",
      baseUrl: "https://api.github.com",
      token: "tok-1",
    });
    await acquirePublishOctokit({
      owner: "acme",
      baseUrl: "https://api.github.com",
      token: "tok-2",
    });
    expect(calls).toBe(2);
  });
});

describe("verifyAuthScope", () => {
  it("rejects when token lacks write permissions", async () => {
    const client = fakeClient(async () => ({
      status: 200,
      headers: {},
      data: { permissions: { push: false }, full_name: "acme/metis" },
    }));
    await expect(verifyAuthScope(client, { owner: "acme", repo: "metis" })).rejects.toBeInstanceOf(
      PublishError,
    );
  });

  it("accepts when token can push", async () => {
    const client = fakeClient(async () => ({
      status: 200,
      headers: {},
      data: { permissions: { push: true }, full_name: "acme/metis" },
    }));
    await expect(verifyAuthScope(client, { owner: "acme", repo: "metis" })).resolves.toEqual({
      login: "acme/metis",
      canWrite: true,
    });
  });

  it("translates 401 → GITHUB_AUTH_FAILED", async () => {
    const client = fakeClient(async () => {
      const e = new Error("Bad credentials") as { status?: number };
      e.status = 401;
      throw e;
    });
    await expect(verifyAuthScope(client, { owner: "acme", repo: "metis" })).rejects.toMatchObject({
      code: "GITHUB_AUTH_FAILED",
    });
  });

  it("translates 404 → GITHUB_REPO_NOT_FOUND", async () => {
    const client = fakeClient(async () => {
      const e = new Error("not found") as { status?: number };
      e.status = 404;
      throw e;
    });
    await expect(verifyAuthScope(client, { owner: "acme", repo: "metis" })).rejects.toMatchObject({
      code: "GITHUB_REPO_NOT_FOUND",
    });
  });

  it("translates 403 → GITHUB_REPO_FORBIDDEN", async () => {
    const client = fakeClient(async () => {
      const e = new Error("forbidden") as { status?: number };
      e.status = 403;
      throw e;
    });
    await expect(verifyAuthScope(client, { owner: "acme", repo: "metis" })).rejects.toMatchObject({
      code: "GITHUB_REPO_FORBIDDEN",
    });
  });
});
