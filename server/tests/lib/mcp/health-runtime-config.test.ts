/**
 * Issue #263 — MCP runtime reads MCP_HEALTH_ALLOW_PARTIAL fresh from
 * `ConfigService` on every health check so an admin flip in the UI takes
 * effect on the next request without restart.
 *
 * The deep health route is heavy (it imports the MCP registry, scheduler
 * bootstrap, AI provider, ...) so we exercise the policy boundary directly
 * via the exported `readAllowPartial` helper. That helper is the single
 * read site for the tunable, so proving it re-reads on every call is
 * sufficient.
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

import { __resetConfigSingleton, getConfigService } from "../../../src/lib/config/index.js";
import { readAllowPartial } from "../../../src/routes/health.js";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  __resetConfigSingleton();
  delete process.env.MCP_HEALTH_ALLOW_PARTIAL;
});
afterEach(() => {
  __resetConfigSingleton();
  process.env = { ...ORIG_ENV };
});

describe("MCP runtime — readAllowPartial (#263)", () => {
  it("returns false when the tunable is unset", () => {
    expect(readAllowPartial()).toBe(false);
  });

  it("returns true when ConfigService resolves to a truthy value", () => {
    const svc = getConfigService();
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.MCP_HEALTH_ALLOW_PARTIAL = "true";
    expect(readAllowPartial()).toBe(true);
  });

  it("flips to false on the next call when the tunable is toggled off", () => {
    const svc = getConfigService();
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.MCP_HEALTH_ALLOW_PARTIAL = "1";
    expect(readAllowPartial()).toBe(true);

    // Admin toggles in the UI — the next call must observe the new value.
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.MCP_HEALTH_ALLOW_PARTIAL = "false";
    expect(readAllowPartial()).toBe(false);
  });

  it("re-reads on every call (no caching across calls)", () => {
    const svc = getConfigService();
    const env = (svc as unknown as { env: NodeJS.ProcessEnv }).env;
    env.MCP_HEALTH_ALLOW_PARTIAL = "true";
    expect(readAllowPartial()).toBe(true);
    env.MCP_HEALTH_ALLOW_PARTIAL = "false";
    expect(readAllowPartial()).toBe(false);
    env.MCP_HEALTH_ALLOW_PARTIAL = "yes";
    expect(readAllowPartial()).toBe(true);
    delete env.MCP_HEALTH_ALLOW_PARTIAL;
    expect(readAllowPartial()).toBe(false);
  });

  it("config.changed event does not break the next read", () => {
    const svc = getConfigService();
    (svc as unknown as { env: NodeJS.ProcessEnv }).env.MCP_HEALTH_ALLOW_PARTIAL = "true";
    svc.emit("config.changed", {
      key: "MCP_HEALTH_ALLOW_PARTIAL",
      oldValue: "false",
      newValue: "true",
      scope: "global",
      tier: "tunable",
    });
    expect(readAllowPartial()).toBe(true);
  });

  it("falls back to env when the registry is unreachable", () => {
    __resetConfigSingleton();
    process.env.MCP_HEALTH_ALLOW_PARTIAL = "1";
    expect(readAllowPartial()).toBe(true);
  });
});
