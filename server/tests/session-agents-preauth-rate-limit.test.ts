/**
 * #236 — `GET /api/ai/session-agents` is bounded per IP BEFORE `requireAuth`
 * (CodeQL `js/missing-rate-limiting`): JWT verification is the first cost an
 * anonymous flood would otherwise impose. The per-user limiter still runs
 * after auth. The pre-auth ceiling is generous — a chat page's normal,
 * authenticated use never meets it.
 *
 * Each test uses its own client IP (`X-Forwarded-For` behind one trusted
 * proxy hop), so the shared limiter's counters never cross tests.
 */
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    prisma: {
      agent: { findMany: vi.fn(async () => []) },
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { aiRouter } = await import("../src/routes/ai.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { CONVERSATION_PREAUTH_DEFAULT_MAX } =
  await import("../src/middleware/conversation-rate-limit.js");

const app = () => {
  const a = express();
  a.set("trust proxy", 1);
  a.use(express.json());
  a.use("/api/ai", aiRouter());
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
};

const get = (ip: string, bearer?: string) => {
  const req = request(app()).get("/api/ai/session-agents").set("X-Forwarded-For", ip);
  return bearer ? req.set("Authorization", `Bearer ${bearer}`) : req;
};

describe("#236 GET /api/ai/session-agents — pre-auth per-IP rate limit", () => {
  afterEach(() => {
    delete process.env.AI_CONVERSATION_PREAUTH_RATE_LIMIT_MAX;
    delete process.env.AI_CONVERSATION_RATE_LIMIT_MAX;
  });

  it("an anonymous flood from one IP gets 429 before auth runs (not 401)", async () => {
    process.env.AI_CONVERSATION_PREAUTH_RATE_LIMIT_MAX = "3";
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await get("198.51.100.7")).status);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    // A valid token from the flooding IP is refused too: the limit is pre-auth.
    const t = issueTokens({ userId: "u-1", username: "u-1", role: "developer", permissions: [] });
    const res = await get("198.51.100.7", t.accessToken);
    expect(res.status).toBe(429);
    expect(res.body.error?.code).toBe("AI_CONVERSATION_RATE_LIMITED");
    // Another IP is unaffected.
    expect((await get("198.51.100.8")).status).toBe(401);
  });

  it("normal authenticated use is unaffected: the per-user limiter still applies after auth", async () => {
    const t = issueTokens({ userId: "u-2", username: "u-2", role: "developer", permissions: [] });
    for (let i = 0; i < 25; i++) {
      const res = await get("198.51.100.20", t.accessToken);
      expect(res.status).toBe(200);
    }
    // The per-user budget (not the IP ceiling) is what a signed-in user meets.
    process.env.AI_CONVERSATION_RATE_LIMIT_MAX = "26";
    expect((await get("198.51.100.20", t.accessToken)).status).toBe(200);
    expect((await get("198.51.100.20", t.accessToken)).status).toBe(429);
  });

  it("the production default is generous: well above the per-user budget", () => {
    expect(CONVERSATION_PREAUTH_DEFAULT_MAX).toBeGreaterThanOrEqual(4 * 300);
  });
});
