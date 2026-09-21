/**
 * Issue #699 (epic #696) — admin prompt-cache telemetry endpoint tests.
 *
 * The load-bearing requirement is ACCESS CONTROL: the aggregator is internal
 * operational telemetry, so an unauthenticated caller must get 401 and an
 * ordinary-tenant (non-admin) caller must get 403 — never the snapshot. These
 * tests exercise the REAL `requirePermission("admin.read")` guard (only
 * `requireAuth` is mocked to inject the caller's role, exactly as the sibling
 * `eval-domain.test.ts` authz suite does), so the 401/403 assertions test the
 * actual authorization logic rather than a stub.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// `requireAuth` is the ONLY auth piece mocked: it injects `currentUser` (or,
// when null, leaves `req.user` undefined so the real permission guard 401s).
// `requirePermission` is the real middleware — this is what makes the 403 test
// meaningful.
interface TestUser {
  userId: string;
  role: string;
}
let currentUser: TestUser | null = { userId: "admin-1", role: "admin" };
vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    if (currentUser) (req as { user: TestUser }).user = currentUser;
    next();
  },
}));

const { cacheTelemetryRouter } = await import("./cache-telemetry.js");
const { errorHandler } = await import("../../middleware/error-handler.js");
const { getCacheHitAggregator, recordCacheHit, __resetCacheHitAggregatorSingleton } =
  await import("../../lib/ai/cache-hit-telemetry.js");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin/cache-telemetry", cacheTelemetryRouter());
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  currentUser = { userId: "admin-1", role: "admin" };
  __resetCacheHitAggregatorSingleton();
});

describe("GET /admin/cache-telemetry — authz (OWASP A01)", () => {
  it("401s an unauthenticated caller (no token → no req.user)", async () => {
    currentUser = null;
    recordCacheHit({ callType: "chat", model: "m", cacheReadTokens: 5, promptTokens: 10 });
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
    // The snapshot must NOT leak to an unauthenticated caller.
    expect(res.body.data).toBeUndefined();
  });

  it("403s an authenticated non-admin caller (lacks admin.read)", async () => {
    currentUser = { userId: "dev-1", role: "developer" };
    recordCacheHit({ callType: "chat", model: "m", cacheReadTokens: 5, promptTokens: 10 });
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.data).toBeUndefined();
  });

  it("403s a reader (still not admin.read)", async () => {
    currentUser = { userId: "reader-1", role: "reader" };
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("allows an admin caller", async () => {
    currentUser = { userId: "root", role: "admin" };
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe("GET /admin/cache-telemetry — snapshot payload", () => {
  it("returns per-(callType, model) rows with the documented shape", async () => {
    // Two calls into one bucket → rolling totals; a second bucket for isolation.
    recordCacheHit({
      callType: "synthesis",
      model: "sonnet",
      cacheReadTokens: 100,
      promptTokens: 400,
    });
    recordCacheHit({
      callType: "synthesis",
      model: "sonnet",
      cacheReadTokens: 300,
      promptTokens: 400,
    });
    recordCacheHit({
      callType: "grounding",
      model: "haiku",
      cacheReadTokens: 0,
      promptTokens: 200,
    });

    const res = await request(makeApp()).get("/admin/cache-telemetry");
    expect(res.status).toBe(200);
    expect(typeof res.body.data.generatedAt).toBe("string");
    expect(Array.isArray(res.body.data.buckets)).toBe(true);
    expect(res.body.data.buckets).toHaveLength(2);

    const synth = res.body.data.buckets.find(
      (b: { callType: string; model: string }) =>
        b.callType === "synthesis" && b.model === "sonnet",
    );
    expect(synth).toMatchObject({
      callType: "synthesis",
      model: "sonnet",
      calls: 2,
      promptTokens: 800,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
    // 400 reads / 800 prompt = 0.5
    expect(synth.hitRatio).toBeCloseTo(0.5, 6);
  });

  it("returns a well-formed EMPTY snapshot when nothing has been recorded", async () => {
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    expect(res.status).toBe(200);
    expect(res.body.data.buckets).toEqual([]);
    expect(res.body.data.totals).toEqual({
      calls: 0,
      promptTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      hitRatio: 0,
      readWriteRatio: null,
    });
  });

  it("surfaces cacheWriteTokens and the read/write ratio when a write-reporting path recorded them", async () => {
    // Native-Anthropic-shaped sample carries creation tokens.
    recordCacheHit({
      callType: "synthesis",
      model: "sonnet",
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
      promptTokens: 1000,
    });
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    const row = res.body.data.buckets[0];
    expect(row.cacheWriteTokens).toBe(100);
    // reads-per-write = 900 / 100 = 9
    expect(row.readWriteRatio).toBeCloseTo(9, 6);
    expect(res.body.data.totals.readWriteRatio).toBeCloseTo(9, 6);
  });

  it("reports readWriteRatio null on the reads-only gateway path (no cache writes)", async () => {
    recordCacheHit({ callType: "chat", model: "sonnet", cacheReadTokens: 500, promptTokens: 1000 });
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    expect(res.body.data.buckets[0].readWriteRatio).toBeNull();
    expect(res.body.data.totals.readWriteRatio).toBeNull();
  });

  it("rolls per-bucket tokens into weighted totals", async () => {
    recordCacheHit({
      callType: "synthesis",
      model: "sonnet",
      cacheReadTokens: 100,
      promptTokens: 200,
    });
    recordCacheHit({
      callType: "grounding",
      model: "haiku",
      cacheReadTokens: 300,
      promptTokens: 600,
    });
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    expect(res.body.data.totals).toMatchObject({
      calls: 2,
      promptTokens: 800,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
    });
    // weighted hit ratio = 400 / 800 = 0.5 (not the average of per-bucket ratios)
    expect(res.body.data.totals.hitRatio).toBeCloseTo(0.5, 6);
  });

  it("never leaks a full ARN — model ids are redacted at record time", async () => {
    const secretArn =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abcd1234";
    // A buggy/hostile caller passing an ARN in the model position is redacted by
    // recordCacheHit before it ever reaches the aggregator (OWASP A09).
    recordCacheHit({ callType: "chat", model: secretArn, cacheReadTokens: 1, promptTokens: 2 });
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(secretArn);
    expect(serialized).not.toMatch(/123456789012/);
    expect(res.body.data.buckets[0].model).toBe("<redacted-arn>");
  });

  // Sanity: the endpoint reads the shared process singleton, so what the
  // provider records is exactly what the endpoint returns.
  it("reads the same shared aggregator the provider writes to", async () => {
    getCacheHitAggregator().record({
      callType: "agent-loop",
      model: "sonnet",
      cacheReadTokens: 10,
      promptTokens: 20,
    });
    const res = await request(makeApp()).get("/admin/cache-telemetry");
    expect(res.body.data.buckets[0]).toMatchObject({ callType: "agent-loop", calls: 1 });
  });
});
