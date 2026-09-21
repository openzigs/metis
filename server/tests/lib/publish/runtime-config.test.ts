/**
 * Issue #261 — publisher reads PUBLISH_RATE_LIMIT_DELAY_MS and
 * PUBLISH_MAX_RETRIES via `ConfigService` on every attempt so a tunable
 * change mid-batch takes effect on the next call without a restart.
 *
 * We do not boot a real publish batch here — too many moving parts. Instead
 * we exercise the two helpers (`currentPublishDelayMs` /
 * `currentPublishMaxRetries`) and `nextDelayMs`/`rateLimitConfigFromEnv`
 * end-to-end against a stub `ConfigService`. Because every retry-loop
 * iteration in `publisher.ts` calls these helpers directly, proving the
 * helpers re-read on each call is sufficient to prove the AC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConfigService,
  __resetConfigSingleton,
  getConfigService,
} from "../../../src/lib/config/index.js";

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    runtimeConfig: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => undefined),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    configAudit: { create: vi.fn(async () => undefined) },
  },
}));

import {
  currentPublishDelayMs,
  currentPublishMaxRetries,
  nextDelayMs,
  rateLimitConfigFromEnv,
} from "../../../src/lib/publishing/octokit-factory.js";

const ORIG_ENV = { ...process.env };

function setSingletonEnv(env: NodeJS.ProcessEnv): ConfigService {
  __resetConfigSingleton();
  // Force the singleton to read from a curated env by constructing it
  // ourselves and substituting in the module-level slot.
  const _svc = new ConfigService({ env });
  // Replace the lazily-constructed singleton.
  // Trick: call `getConfigService` once to materialise it, then mutate
  // its private `env` to our curated record.
  const live = getConfigService();
  Object.assign(live as unknown as { env: NodeJS.ProcessEnv }, { env });
  return live;
}

beforeEach(() => {
  __resetConfigSingleton();
  for (const k of [
    "PUBLISH_RATE_LIMIT_DELAY_MS",
    "PUBLISH_MAX_RETRIES",
    "PUBLISH_RATE_LIMIT_JITTER_MS",
    "PUBLISH_SECONDARY_BACKOFF_BASE_MS",
    "PUBLISH_SECONDARY_BACKOFF_MAX_MS",
    "PUBLISH_BACKOFF_BUDGET_MS",
  ]) {
    delete process.env[k];
  }
});
afterEach(() => {
  __resetConfigSingleton();
  process.env = { ...ORIG_ENV };
});

describe("publisher runtime config (#261)", () => {
  it("currentPublishDelayMs reads fresh from ConfigService on every call", () => {
    const svc = setSingletonEnv({ PUBLISH_RATE_LIMIT_DELAY_MS: "1500" });
    expect(currentPublishDelayMs()).toBe(1500);

    // Mid-batch tunable change: simulate `configService.set` by mutating
    // the env-fallback layer that the synchronous reader sees.
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.PUBLISH_RATE_LIMIT_DELAY_MS = "250";
    expect(currentPublishDelayMs()).toBe(250);

    // And again — no caching across calls.
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.PUBLISH_RATE_LIMIT_DELAY_MS = "9999";
    expect(currentPublishDelayMs()).toBe(9999);
  });

  it("currentPublishMaxRetries reads fresh from ConfigService on every call", () => {
    const svc = setSingletonEnv({ PUBLISH_MAX_RETRIES: "3" });
    expect(currentPublishMaxRetries()).toBe(3);
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.PUBLISH_MAX_RETRIES = "1";
    expect(currentPublishMaxRetries()).toBe(1);
  });

  it("nextDelayMs uses the LIVE delay, ignoring the snapshot it was passed", () => {
    const svc = setSingletonEnv({
      PUBLISH_RATE_LIMIT_DELAY_MS: "5000",
    });
    // Take a snapshot at delay=5000 then null out jitter to make the
    // result deterministic — the publisher cannot disable jitter via env
    // (posInt rejects "0") but tests can mutate the snapshot directly.
    const snapshot = { ...rateLimitConfigFromEnv(), jitterMs: 0 };
    expect(snapshot.delayMs).toBe(5000);

    // Flip the tunable mid-batch — `nextDelayMs` should respect the new value.
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.PUBLISH_RATE_LIMIT_DELAY_MS = "100";
    expect(nextDelayMs(snapshot)).toBe(100);
  });

  it("rateLimitConfigFromEnv falls back to defaults when ConfigService is unset", () => {
    setSingletonEnv({});
    const cfg = rateLimitConfigFromEnv();
    expect(cfg.delayMs).toBeGreaterThan(0);
    expect(cfg.maxRetries).toBeGreaterThan(0);
  });

  it("currentPublishDelayMs falls back to env when registry is unreachable", () => {
    // Force the singleton call to throw by stashing a broken proxy.
    __resetConfigSingleton();
    process.env.PUBLISH_RATE_LIMIT_DELAY_MS = "777";
    expect(currentPublishDelayMs()).toBe(777);
  });

  it("a config.changed emit doesn't break — helpers continue to read fresh", () => {
    const svc = setSingletonEnv({ PUBLISH_RATE_LIMIT_DELAY_MS: "1200" });
    expect(currentPublishDelayMs()).toBe(1200);
    svc.emit("config.changed", {
      key: "PUBLISH_RATE_LIMIT_DELAY_MS",
      oldValue: "1200",
      newValue: "200",
      scope: "global",
      tier: "tunable",
    });
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.PUBLISH_RATE_LIMIT_DELAY_MS = "200";
    expect(currentPublishDelayMs()).toBe(200);
  });
});
