/**
 * Issue #316 — admin/mcp rate limiter regression tests.
 *
 * Verifies:
 *   - 429 returned after a small burst on `/api/admin/*` and `/api/mcp/*`
 *   - `/healthz` and `/readyz` are NOT rate-limited (they live outside `/api`)
 *   - Buckets are keyed per IP (different `X-Forwarded-For` is a fresh quota)
 *   - `ADMIN_RATE_LIMIT_MAX` / `MCP_RATE_LIMIT_MAX` env knobs are honoured
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn() },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

import request from "supertest";
import type { Application } from "express";

const ORIGINAL = { ...process.env };

async function freshApp(envOverrides: Record<string, string>): Promise<Application> {
  for (const [k, v] of Object.entries(envOverrides)) {
    process.env[k] = v;
  }
  vi.resetModules();
  const { __resetMcpAdminRateLimiters } =
    await import("../../src/middleware/mcp-admin-rate-limit.js");
  __resetMcpAdminRateLimiters();
  const { createApp } = await import("../../src/app.js");
  return createApp();
}

beforeAll(() => {
  // Confine all tests to a short window so we never trip the default 15-min
  // bucket between cases.
  process.env.ADMIN_RATE_LIMIT_WINDOW_MS = "60000";
  process.env.MCP_RATE_LIMIT_WINDOW_MS = "60000";
});

afterAll(() => {
  process.env = { ...ORIGINAL };
});

describe("mcpAdminRateLimiter", () => {
  beforeEach(() => {
    delete process.env.ADMIN_RATE_LIMIT_MAX;
    delete process.env.MCP_RATE_LIMIT_MAX;
  });

  it("returns 429 after exceeding the configured admin limit on /api/admin/*", async () => {
    const app = await freshApp({ ADMIN_RATE_LIMIT_MAX: "5", MCP_RATE_LIMIT_MAX: "999" });
    let lastStatus = 0;
    for (let i = 0; i < 7; i += 1) {
      const res = await request(app).get("/api/admin/config").set("X-Forwarded-For", "10.0.0.1");
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  }, 30_000);

  it("returns 429 after exceeding the configured mcp limit on /api/mcp/*", async () => {
    const app = await freshApp({ ADMIN_RATE_LIMIT_MAX: "999", MCP_RATE_LIMIT_MAX: "5" });
    let lastStatus = 0;
    for (let i = 0; i < 7; i += 1) {
      const res = await request(app).get("/api/mcp").set("X-Forwarded-For", "10.0.0.2");
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  }, 30_000);

  it("does NOT rate-limit /healthz or /readyz even under burst", async () => {
    const app = await freshApp({ ADMIN_RATE_LIMIT_MAX: "2", MCP_RATE_LIMIT_MAX: "2" });
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app).get("/healthz").set("X-Forwarded-For", "10.0.0.3");
      expect(res.status).toBe(200);
    }
    // /readyz can return 200 OR 503 depending on subsystems but must not be 429.
    for (let i = 0; i < 10; i += 1) {
      const res = await request(app).get("/readyz").set("X-Forwarded-For", "10.0.0.3");
      expect(res.status).not.toBe(429);
    }
  }, 30_000);

  it("uses separate buckets per IP", async () => {
    const app = await freshApp({ ADMIN_RATE_LIMIT_MAX: "3", MCP_RATE_LIMIT_MAX: "999" });
    // Burn IP A's quota.
    for (let i = 0; i < 4; i += 1) {
      await request(app).get("/api/admin/config").set("X-Forwarded-For", "10.0.1.1");
    }
    // IP B should still get through.
    const res = await request(app).get("/api/admin/config").set("X-Forwarded-For", "10.0.1.2");
    expect(res.status).not.toBe(429);
  }, 30_000);

  it("includes a Retry-After-style standard rate-limit header on 429", async () => {
    const app = await freshApp({ ADMIN_RATE_LIMIT_MAX: "1", MCP_RATE_LIMIT_MAX: "999" });
    await request(app).get("/api/admin/config").set("X-Forwarded-For", "10.0.2.1");
    const res = await request(app).get("/api/admin/config").set("X-Forwarded-For", "10.0.2.1");
    expect(res.status).toBe(429);
    // express-rate-limit v7 sets `RateLimit-*` standard headers.
    expect(res.headers["ratelimit-limit"] ?? res.headers["RateLimit-Limit"]).toBeDefined();
  }, 30_000);
});
