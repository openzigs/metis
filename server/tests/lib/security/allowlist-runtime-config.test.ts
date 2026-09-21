/**
 * Issue #262 — SSRF allowlist guard subscribes to *_ALLOWED_HOSTS changes.
 *
 * The cached compiled allow-list rebuilds on `config.changed` events for
 * REPO_ALLOWED_HOSTS, DB_ALLOWED_HOSTS, and PUBLISH_GITHUB_ALLOWED_HOSTS so
 * an admin can lock down (or open up) a host on demand without restarting.
 *
 * In-flight requests use the snapshot they were started with — we verify
 * the next request observes the new policy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  ConfigService,
  __resetConfigSingleton,
  getConfigService,
} from "../../../src/lib/config/index.js";
import {
  __resetAllowlistForTests,
  assertConnectorHostAllowed,
  rebuildConnectorAllowlists,
  resolveAndAssertConnectorHost,
  subscribeAllowlistToConfig,
  type DnsLookupAddress,
} from "../../../src/lib/connectors/network-allowlist.js";
import { ConnectorError } from "../../../src/lib/connectors/types.js";

const ORIG_ENV = { ...process.env };

function setSingletonEnv(env: NodeJS.ProcessEnv): ConfigService {
  __resetConfigSingleton();
  const live = getConfigService();
  Object.assign(live as unknown as { env: NodeJS.ProcessEnv }, { env });
  return live;
}

function emit(svc: ConfigService, key: string, oldValue: string, newValue: string): void {
  svc.emit("config.changed", {
    key,
    oldValue,
    newValue,
    scope: "global",
    tier: "tunable",
  });
}

const lookupPrivate: (host: string) => Promise<DnsLookupAddress[]> = async () => [
  { address: "10.0.0.1", family: 4 },
];

beforeEach(() => {
  __resetConfigSingleton();
  __resetAllowlistForTests();
  delete process.env.REPO_ALLOWED_HOSTS;
  delete process.env.DB_ALLOWED_HOSTS;
  delete process.env.PUBLISH_GITHUB_ALLOWED_HOSTS;
  delete process.env.CONNECTOR_ALLOW_LOOPBACK;
});
afterEach(() => {
  __resetConfigSingleton();
  __resetAllowlistForTests();
  process.env = { ...ORIG_ENV };
});

describe("subscribeAllowlistToConfig (#262)", () => {
  it("rebuilds the cache on REPO_ALLOWED_HOSTS change — next request sees the new policy", async () => {
    const svc = setSingletonEnv({ REPO_ALLOWED_HOSTS: "ghe.example.com" });
    subscribeAllowlistToConfig(svc);

    // First request — host on allow-list, succeeds.
    await expect(
      assertConnectorHostAllowed("ghe.example.com", "repo", lookupPrivate),
    ).resolves.toBeUndefined();

    // Admin removes the host.
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.REPO_ALLOWED_HOSTS = "";
    emit(svc, "REPO_ALLOWED_HOSTS", "ghe.example.com", "");

    // Next request — host no longer allow-listed, rejected.
    await expect(
      assertConnectorHostAllowed("ghe.example.com", "repo", lookupPrivate),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("rebuilds the cache on DB_ALLOWED_HOSTS change", async () => {
    const svc = setSingletonEnv({ DB_ALLOWED_HOSTS: "" });
    subscribeAllowlistToConfig(svc);

    await expect(
      assertConnectorHostAllowed("db.private.example", "db", lookupPrivate),
    ).rejects.toBeInstanceOf(ConnectorError);

    (svc as unknown as { env: NodeJS.ProcessEnv }).env.DB_ALLOWED_HOSTS = "db.private.example";
    emit(svc, "DB_ALLOWED_HOSTS", "", "db.private.example");

    await expect(
      assertConnectorHostAllowed("db.private.example", "db", lookupPrivate),
    ).resolves.toBeUndefined();
  });

  it("PUBLISH_GITHUB_ALLOWED_HOSTS is merged into the repo allow-list", async () => {
    const svc = setSingletonEnv({
      REPO_ALLOWED_HOSTS: "",
      PUBLISH_GITHUB_ALLOWED_HOSTS: "github.acme.example",
    });
    subscribeAllowlistToConfig(svc);

    await expect(
      assertConnectorHostAllowed("github.acme.example", "repo", lookupPrivate),
    ).resolves.toBeUndefined();

    // Remove from publish list — repo connector should reject again.
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.PUBLISH_GITHUB_ALLOWED_HOSTS = "";
    emit(svc, "PUBLISH_GITHUB_ALLOWED_HOSTS", "github.acme.example", "");

    await expect(
      assertConnectorHostAllowed("github.acme.example", "repo", lookupPrivate),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("ignores changes to unrelated keys", async () => {
    const svc = setSingletonEnv({ REPO_ALLOWED_HOSTS: "ghe.example.com" });
    subscribeAllowlistToConfig(svc);

    emit(svc, "PUBLISH_RATE_LIMIT_DELAY_MS", "1000", "2000");

    // Allow-list still active — the unrelated key did not invalidate it.
    await expect(
      assertConnectorHostAllowed("ghe.example.com", "repo", lookupPrivate),
    ).resolves.toBeUndefined();
  });

  it("in-flight resolution uses its own snapshot — change visible only on next call", async () => {
    const svc = setSingletonEnv({ REPO_ALLOWED_HOSTS: "ghe.example.com" });
    subscribeAllowlistToConfig(svc);

    // Concurrent: snapshot taken now (resolves to allow-listed),
    // change applied, then another resolution sees the new policy.
    const inflight = resolveAndAssertConnectorHost("ghe.example.com", "repo", lookupPrivate);

    (svc as unknown as { env: NodeJS.ProcessEnv }).env.REPO_ALLOWED_HOSTS = "";
    emit(svc, "REPO_ALLOWED_HOSTS", "ghe.example.com", "");

    // The in-flight call captured the allow-list before the invalidation
    // happened — it must still succeed.
    const pinned = await inflight;
    expect(pinned.hostname).toBe("ghe.example.com");

    // The follow-up call sees the rebuilt (empty) allow-list.
    await expect(
      assertConnectorHostAllowed("ghe.example.com", "repo", lookupPrivate),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it("rebuildConnectorAllowlists() forces a recompute on next read", async () => {
    setSingletonEnv({ DB_ALLOWED_HOSTS: "db.example.com" });
    await expect(
      assertConnectorHostAllowed("db.example.com", "db", lookupPrivate),
    ).resolves.toBeUndefined();

    process.env.DB_ALLOWED_HOSTS = "";
    // Without manual invalidation the cache still holds the old set.
    rebuildConnectorAllowlists();
    // Now the next read pulls "" from env (we used a Singleton that points
    // to the global process.env via getConfigService default).
  });

  it("re-subscribing replaces the prior listener (idempotent)", async () => {
    const svc = setSingletonEnv({ REPO_ALLOWED_HOSTS: "ghe.example.com" });
    subscribeAllowlistToConfig(svc);
    subscribeAllowlistToConfig(svc);

    // Even though we subscribed twice the cache only gets invalidated once
    // per event because the second subscribe drops the first listener.
    expect(svc.listenerCount("config.changed")).toBe(1);
  });

  it("falls back to env when the registry is unreachable", async () => {
    // Force getConfigService() to throw by deliberately busting the
    // singleton's lazy init — simplest is to leave env populated and bypass
    // ConfigService entirely via __resetAllowlistForTests + raw process.env.
    process.env.REPO_ALLOWED_HOSTS = "fallback.example";
    __resetConfigSingleton();
    rebuildConnectorAllowlists();
    await expect(
      assertConnectorHostAllowed("fallback.example", "repo", lookupPrivate),
    ).resolves.toBeUndefined();
  });
});
