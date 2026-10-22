/**
 * Rate limiter trip test — fires more than the configured max and asserts the
 * later requests get 429.
 *
 * #1288 — the `auth rate limiter` suite used to set `RATE_LIMIT_MAX=20`, call
 * `vi.resetModules()` and re-import `createApp` inside a `beforeAll(…, 30_000)`
 * purely to move one number. That second, COLD import of the whole application
 * module graph timed out at 30 s under full-suite fan-out on the shared runner
 * (`Error: Hook timed out in 30000ms.`, measured on `main` at run 31184784728),
 * which skips the suite's tests rather than failing them — one file red with
 * ZERO failed tests, the same surface signature as the `cost-tracker.test.ts`
 * teardown flake, so it was repeatedly re-run instead of fixed. `retry: 2` never
 * helped: Vitest does not retry a failed suite-level hook.
 *
 * The limiter is now built directly via `createAuthRateLimiter` with a private
 * counter and an INJECTED CLOCK, so these tests import no application module,
 * share no module-level state with anything else in the worker, and assert
 * window behaviour without racing (or sleeping out) wall time.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn() },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

import express from "express";
import request from "supertest";
import { createAuthRateLimiter, isRateLimitExempt } from "../src/middleware/rate-limit.js";
import {
  CLIENT_ADDRESS_HEADER,
  CLIENT_ADDRESS_SIGNATURE_HEADER,
  clientAddressSignature,
} from "../src/middleware/auth-client-address.js";
import { clusterRateLimitStore } from "../src/middleware/cluster-rate-limit-store.js";
import { createApp, parseTrustProxy } from "../src/app.js";

describe("isRateLimitExempt", () => {
  it("exempts GET /me (session check)", () => {
    expect(isRateLimitExempt("GET", "/me")).toBe(true);
  });

  it("exempts GET /sso/providers (public login-page provider list, #452)", () => {
    expect(isRateLimitExempt("GET", "/sso/providers")).toBe(true);
  });

  it("does NOT exempt POST /sso/providers (only GET is read-only)", () => {
    expect(isRateLimitExempt("POST", "/sso/providers")).toBe(false);
  });

  it("does NOT exempt credential routes — GET /login", () => {
    expect(isRateLimitExempt("GET", "/login")).toBe(false);
  });

  it("does NOT exempt credential routes — POST /login", () => {
    expect(isRateLimitExempt("POST", "/login")).toBe(false);
  });

  it("does NOT broaden to all of /sso/* — GET /sso/saml/login stays throttled", () => {
    expect(isRateLimitExempt("GET", "/sso/saml/login")).toBe(false);
  });

  it("does NOT exempt SSO callbacks — POST /sso/saml/callback", () => {
    expect(isRateLimitExempt("POST", "/sso/saml/callback")).toBe(false);
  });

  it("does NOT exempt refresh/logout credential routes", () => {
    expect(isRateLimitExempt("POST", "/refresh")).toBe(false);
    expect(isRateLimitExempt("POST", "/logout")).toBe(false);
  });
});

/**
 * Mount the real limiter on a minimal router at `/auth`, exactly where
 * `routes/index.ts` mounts it, so `req.path` the skip predicate sees (`/me`,
 * `/sso/providers`, `/login`) is identical to production.
 */
function harness(options: { max?: number; windowMs?: number } = {}) {
  const windowMs = options.windowMs ?? 15 * 60_000;
  // A fixed, arbitrary epoch. Nothing reads the wall clock.
  let clock = 1_700_000_000_000;
  const app = express();
  // #1385 — the limiter no longer reads `req.ip` on a credential route, but the
  // app still trusts what production trusts: read through the SAME parser
  // `createApp` uses so the harness cannot drift from production.
  app.set("trust proxy", parseTrustProxy(process.env.TRUST_PROXY));
  app.use(express.json());
  app.use(
    "/auth",
    createAuthRateLimiter({
      max: options.max ?? 20,
      windowMs,
      // A store built here resolves its own in-memory backend, so the counter is
      // private to this harness — no module-level singleton is touched.
      store: clusterRateLimitStore("auth", { now: () => clock }),
    }),
    (_req, res) => {
      // Stand-in for the credential routes: the limiter runs first either way.
      res.status(401).json({ success: false });
    },
  );
  return {
    app,
    windowMs,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("auth rate limiter", () => {
  it("admits exactly `max` requests, then returns 429", async () => {
    const { app } = harness({ max: 20 });
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1) {
      const res = await request(app)
        .post("/auth/login")
        .set("X-Forwarded-For", "9.9.9.9")
        .send({ username: "nope", password: "nope" });
      statuses.push(res.status);
    }
    // The trip point is asserted exactly, not "429 happened somewhere in 22".
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(401));
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it("counts per client IP — a second IP gets its own budget", async () => {
    // #1385 — the address is the one the UI proxy signs, never X-Forwarded-For.
    const secret = "rate-limit-test-ui-proxy-secret-0123456789";
    process.env.METIS_UI_PROXY_SECRET = secret;
    try {
      const { app } = harness({ max: 2 });
      const fire = (ip: string) =>
        request(app)
          .post("/auth/login")
          .set(CLIENT_ADDRESS_HEADER, ip)
          .set(CLIENT_ADDRESS_SIGNATURE_HEADER, clientAddressSignature(secret, ip))
          .send({});
      expect((await fire("1.1.1.1")).status).toBe(401);
      expect((await fire("1.1.1.1")).status).toBe(401);
      expect((await fire("1.1.1.1")).status).toBe(429);
      // A different IP is unaffected by the first one's saturated window.
      expect((await fire("2.2.2.2")).status).toBe(401);
    } finally {
      delete process.env.METIS_UI_PROXY_SECRET;
    }
  });

  it("keeps the client throttled up to the last millisecond of the window", async () => {
    const { app, advance, windowMs } = harness({ max: 1 });
    const fire = () => request(app).post("/auth/login").set("X-Forwarded-For", "9.9.9.9").send({});
    expect((await fire()).status).toBe(401);
    expect((await fire()).status).toBe(429);
    advance(windowMs - 1);
    expect((await fire()).status).toBe(429);
  });

  it("frees the budget once the window elapses ON THE INJECTED CLOCK", async () => {
    const { app, advance, windowMs } = harness({ max: 1 });
    const fire = () => request(app).post("/auth/login").set("X-Forwarded-For", "9.9.9.9").send({});
    expect((await fire()).status).toBe(401);
    expect((await fire()).status).toBe(429);
    // Wall time would need a real 15-minute sleep to reach here.
    advance(windowMs + 1);
    expect((await fire()).status).toBe(401);
  });

  it("does not count session checks against the credential-stuffing limiter", async () => {
    const { app } = harness({ max: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      statuses.push((await request(app).get("/auth/me").set("X-Forwarded-For", "8.8.8.8")).status);
    }
    expect(statuses).not.toContain(429);
    // The exempt requests must also not consume the budget of the same IP.
    expect((await request(app).post("/auth/login").set("X-Forwarded-For", "8.8.8.8")).status).toBe(
      401,
    );
  });

  it("does not throttle the public GET /sso/providers (login-page load, #452)", async () => {
    const { app } = harness({ max: 2 });
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      statuses.push(
        (await request(app).get("/auth/sso/providers").set("X-Forwarded-For", "7.7.7.7")).status,
      );
    }
    expect(statuses).not.toContain(429);
  });
});

/**
 * The harness above proves the limiter's BEHAVIOUR. These prove it is actually
 * MOUNTED on the real auth routes — the only thing the deleted re-import test
 * added — using one request each against a normally-imported app. No
 * `vi.resetModules()`, no env mutation, no 30 s hook.
 *
 * `standardHeaders: true` means a request the limiter counted carries
 * `ratelimit-*`; one it skipped carries none. That is a direct read of whether
 * the middleware ran, and it holds at the suite's sky-high `RATE_LIMIT_MAX`.
 */
describe("auth rate limiter wiring (#1288)", () => {
  const app = createApp();

  it("counts POST /api/auth/login — the credential route is throttled", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "6.6.6.6")
      .send({ username: "nope", password: "nope" });
    expect(res.headers).toHaveProperty("ratelimit-limit");
  });

  it("skips GET /api/auth/me — the exemption is wired, not just unit-tested", async () => {
    const res = await request(app).get("/api/auth/me").set("X-Forwarded-For", "6.6.6.7");
    expect(res.status).toBe(401);
    expect(res.headers).not.toHaveProperty("ratelimit-limit");
  });

  it("skips GET /api/auth/sso/providers and still serves it 200 (#452)", async () => {
    const res = await request(app).get("/api/auth/sso/providers").set("X-Forwarded-For", "6.6.6.8");
    expect(res.status).toBe(200);
    expect(res.headers).not.toHaveProperty("ratelimit-limit");
  });

  it("mounts the per-account login limiter on POST /api/auth/login (#1385)", async () => {
    // The cap is read per request, so this moves it without re-importing the app.
    const previous = process.env.AUTH_ACCOUNT_RATE_LIMIT_MAX;
    process.env.AUTH_ACCOUNT_RATE_LIMIT_MAX = "2";
    try {
      const login = () =>
        request(app)
          .post("/api/auth/login")
          .send({ username: "wiring-1385-account", password: "nope" });
      expect((await login()).status).not.toBe(429);
      expect((await login()).status).not.toBe(429);
      const res = await login();
      expect(res.status).toBe(429);
      expect(res.body.error.message).toMatch(/this account/);
    } finally {
      process.env.AUTH_ACCOUNT_RATE_LIMIT_MAX = previous;
    }
  });
});
