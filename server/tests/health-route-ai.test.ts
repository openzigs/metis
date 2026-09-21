/**
 * Health route — AI provider branch coverage. Targets the previously
 * uncovered "unreachable" + "catch" paths in the deep health check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn(async () => ({ id: "user_admin" })) },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { setHealthProviderForTests } from "../src/routes/health.js";
import type { AIProvider } from "../src/lib/ai/index.js";

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp();
  // Pull AI out of offline-stub mode so the ping path actually runs.
  process.env.AI_OFFLINE = "false";
  process.env.AI_PROVIDER = "anthropic";
  process.env.AI_PING_TIMEOUT_MS = "50";
});

afterEach(() => {
  setHealthProviderForTests(null);
  delete process.env.AI_OFFLINE;
  delete process.env.AI_PROVIDER;
  delete process.env.AI_PING_TIMEOUT_MS;
  delete process.env.ANTHROPIC_API_KEY;
});

describe("/readyz AI branch", () => {
  it("ok when the AI provider ping resolves true", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    setHealthProviderForTests({
      name: "anthropic",
      ping: async () => true,
    } as unknown as AIProvider);
    const res = await request(app).get("/readyz");
    expect(res.body.checks.ai.status).toBe("ok");
  });

  it("degraded when the AI provider ping resolves false", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    setHealthProviderForTests({
      name: "anthropic",
      ping: async () => false,
    } as unknown as AIProvider);
    const res = await request(app).get("/readyz");
    expect(res.body.checks.ai.status).toBe("degraded");
    expect(res.body.checks.ai.message).toMatch(/unreachable/);
  });

  it("degraded when AI config cannot be loaded (catch path)", async () => {
    // No ANTHROPIC_API_KEY — loadAIConfig throws. Verifies the catch block
    // records a degraded check rather than crashing the deep-health endpoint.
    delete process.env.ANTHROPIC_API_KEY;
    const res = await request(app).get("/readyz");
    expect(res.body.checks.ai.status).toBe("degraded");
  });
});
