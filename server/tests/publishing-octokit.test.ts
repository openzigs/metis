/**
 * Octokit factory + throttle hooks + auth scope verifier — Phase 9 (#66).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  makePinnedLookup: vi.fn(() => undefined),
}));

import {
  PUBLISH_OCTOKIT_CACHE_MAX,
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
import type {
  OctokitRequestArgs,
  OctokitResponseLike,
  PublishOctokitLike,
} from "../src/lib/publishing/types.js";

const GH = "https://api.github.com";

afterEach(() => {
  __setPublishOctokitFactory(null);
  __resetPublishOctokitCache();
  vi.restoreAllMocks();
  delete process.env.PUBLISH_RATE_LIMIT_DELAY_MS;
  delete process.env.PUBLISH_RATE_LIMIT_JITTER_MS;
});

function fakeClient(
  impl: (args: OctokitRequestArgs) => Promise<OctokitResponseLike>,
): PublishOctokitLike {
  // `request<T>` is caller-typed, as on the real client: `T` is what the caller
  // asserts the body holds, so a fake can only hand back `unknown` data.
  return { request: impl as PublishOctokitLike["request"] };
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

  it("rotates client on token change", async () => {
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

  // #749 — the old fingerprint was length + first 2 + last 2 characters, so
  // two classic `ghp_` PATs differing only in the middle shared one client and
  // a publish went out under the other project's credential.
  it("never shares a client between tokens that differ only in the middle", async () => {
    const tokensSeen: string[] = [];
    __setPublishOctokitFactory(async (args) => {
      tokensSeen.push(args.token);
      return fakeClient(async () => ({ status: 200, headers: {}, data: {} }));
    });
    const tokenA = `ghp_${"A".repeat(34)}zz`;
    const tokenB = `ghp_${"B".repeat(34)}zz`;
    expect(tokenA).toHaveLength(tokenB.length);

    const a = await acquirePublishOctokit({ owner: "openzigs", baseUrl: GH, token: tokenA });
    const b = await acquirePublishOctokit({ owner: "openzigs", baseUrl: GH, token: tokenB });

    expect(b).not.toBe(a);
    expect(tokensSeen).toEqual([tokenA, tokenB]);
  });

  it("keeps one client per token, so alternating projects do not rebuild", async () => {
    let calls = 0;
    __setPublishOctokitFactory(async () => {
      calls += 1;
      return fakeClient(async () => ({ status: 200, headers: {}, data: {} }));
    });
    const a1 = await acquirePublishOctokit({ owner: "openzigs", baseUrl: GH, token: "tok-a" });
    const b1 = await acquirePublishOctokit({ owner: "openzigs", baseUrl: GH, token: "tok-b" });
    const a2 = await acquirePublishOctokit({ owner: "openzigs", baseUrl: GH, token: "tok-a" });
    const b2 = await acquirePublishOctokit({ owner: "openzigs", baseUrl: GH, token: "tok-b" });

    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    expect(calls).toBe(2);
  });

  it("builds a new client when the pinned address changes", async () => {
    const pins: Array<string | undefined> = [];
    __setPublishOctokitFactory(async (args) => {
      pins.push(args.pinnedAddress);
      return fakeClient(async () => ({ status: 200, headers: {}, data: {} }));
    });
    const base = { owner: "acme", baseUrl: "https://ghe.example.test/api/v3", token: "tok-1" };

    const first = await acquirePublishOctokit({
      ...base,
      pinnedAddress: "203.0.113.5",
      pinnedFamily: 4,
    });
    const again = await acquirePublishOctokit({
      ...base,
      pinnedAddress: "203.0.113.5",
      pinnedFamily: 4,
    });
    const moved = await acquirePublishOctokit({
      ...base,
      pinnedAddress: "203.0.113.9",
      pinnedFamily: 4,
    });

    expect(again).toBe(first);
    expect(moved).not.toBe(first);
    expect(pins).toEqual(["203.0.113.5", "203.0.113.9"]);
  });

  it("bounds the cache, evicting the least recently used client", async () => {
    let calls = 0;
    __setPublishOctokitFactory(async () => {
      calls += 1;
      return fakeClient(async () => ({ status: 200, headers: {}, data: {} }));
    });
    const acquire = (token: string) => acquirePublishOctokit({ owner: "acme", baseUrl: GH, token });

    const keep = await acquire("tok-keep");
    for (let i = 0; i < PUBLISH_OCTOKIT_CACHE_MAX - 1; i++) await acquire(`tok-${i}`);
    // Touch `tok-keep` so `tok-0` becomes the least recently used entry.
    expect(await acquire("tok-keep")).toBe(keep);
    await acquire("tok-overflow");
    expect(calls).toBe(PUBLISH_OCTOKIT_CACHE_MAX + 1);

    expect(await acquire("tok-keep")).toBe(keep);
    expect(calls).toBe(PUBLISH_OCTOKIT_CACHE_MAX + 1);
    await acquire("tok-0");
    expect(calls).toBe(PUBLISH_OCTOKIT_CACHE_MAX + 2);
  });

  it("never logs token material", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/lib/publishing/octokit-factory.ts", import.meta.url)),
      "utf8",
    );
    const logCalls = source.match(/log\.\w+\([^;]*;/g) ?? [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) expect(call).not.toMatch(/token|auth|fingerprint/i);
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
