/**
 * Issue #258 — verifies that token-cap getters resolve through ConfigService
 * so an admin write takes effect on the next analysis call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    runtimeConfig: { findMany: vi.fn(async () => []) },
    analysis: { findMany: vi.fn(async () => []) },
  },
}));

import { getAgentTokenCap, getMonthlyTokenCap } from "../../../src/lib/analysis/cost-cap.js";
import { __resetConfigSingleton, getConfigService } from "../../../src/lib/config/index.js";

const ENV_KEYS = ["ANALYSIS_MONTHLY_TOKEN_CAP", "ANALYSIS_AGENT_TOKEN_CAP"];
const stash: Record<string, string | undefined> = {};

beforeEach(() => {
  __resetConfigSingleton();
  for (const k of ENV_KEYS) {
    stash[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  __resetConfigSingleton();
  for (const k of ENV_KEYS) {
    if (stash[k] === undefined) delete process.env[k];
    else process.env[k] = stash[k];
  }
});

describe("cost-cap runtime switching (#258)", () => {
  it("falls back to baseline defaults when nothing is configured", () => {
    expect(getMonthlyTokenCap()).toBeGreaterThan(0);
    expect(getAgentTokenCap()).toBeGreaterThan(0);
  });

  it("env value is used when no tunable override is set", () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "12345";
    expect(getMonthlyTokenCap()).toBe(12345);
  });

  it("tunable cache wins over env value", () => {
    process.env.ANALYSIS_MONTHLY_TOKEN_CAP = "12345";
    const svc = getConfigService();
    // @ts-expect-error — test seam: bypass the DB and prime the cache.
    svc["tunableCache"].set("ANALYSIS_MONTHLY_TOKEN_CAP", "999000");
    // @ts-expect-error — see above.
    svc["tunableDbBacked"].add("ANALYSIS_MONTHLY_TOKEN_CAP");
    expect(getMonthlyTokenCap()).toBe(999000);
  });

  it("agent cap honours the tunable cache", () => {
    const svc = getConfigService();
    // @ts-expect-error — test seam.
    svc["tunableCache"].set("ANALYSIS_AGENT_TOKEN_CAP", "42000");
    // @ts-expect-error — test seam.
    svc["tunableDbBacked"].add("ANALYSIS_AGENT_TOKEN_CAP");
    expect(getAgentTokenCap()).toBe(42000);
  });
});
