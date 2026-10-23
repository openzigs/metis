/**
 * Issue #1116 — the rate limiters on every route of `backgroundRunsRouter`
 * (`/api/runs/background…`, `/api/runs/group…`, `/api/runs/:id/steer`), which
 * shares the `/api/runs` prefix with `runsRouter` and had none.
 *
 * Through the REAL router with real access tokens; only the database and the
 * async runner are stand-ins, because what is under test is the middleware
 * chain, not what a handler does once it is reached.
 *
 * What it pins, per route:
 *   • a guard runs AHEAD of `requireAuth` (the position CodeQL
 *     `js/missing-rate-limiting` counts) and a per-user budget after it;
 *   • served within budget, `429 RUNS_RATE_LIMITED` past it, another user
 *     unaffected;
 *   • reads spend the `/api/runs` read budget (`RUNS_LIMIT_MAX`), writes a
 *     smaller budget of their own (`RUNS_WRITE_LIMIT_MAX`), and neither spends
 *     the other.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    // #1438 — submit refuses a soft-deleted project; none is deleted here.
    project: { findMany: vi.fn(async () => []) },
    backgroundRun: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ id: "run_1", status: "running", messages: [] })),
    },
    runGroup: { findFirst: vi.fn(async () => ({ id: "grp_1", runs: [] })) },
    runMessage: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: "msg_1" })),
    },
  },
}));
vi.mock("../src/lib/async/run-authz.js", () => ({
  authorizeBackgroundRun: vi.fn(async () => undefined),
  authorizeRunGroup: vi.fn(async () => undefined),
  authorizeRunProject: vi.fn(async () => undefined),
  runProjectScope: vi.fn(() => ({})),
}));
vi.mock("../src/lib/async/runner.js", () => ({
  getAsyncRunner: () => ({
    submit: vi.fn(async () => ({ id: "run_new" })),
    cancel: vi.fn(async () => true),
    pause: vi.fn(async () => true),
    resume: vi.fn(async () => true),
  }),
}));
vi.mock("../src/lib/async/best-of-n.js", () => ({
  submitGroup: vi.fn(async () => ({ groupId: "grp_new", runIds: ["run_new"] })),
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";

const { errorHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { requireAuth } = await import("../src/middleware/auth.js");
const { backgroundRunsRouter } = await import("../src/routes/background-runs.js");
const limits = await import("../src/middleware/runs-rate-limit.js");

const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/runs", backgroundRunsRouter());
  a.use(errorHandler);
  return a;
};

const tokenFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  }).accessToken;

type Route = { method: "get" | "post"; path: string; body?: object; ok: number };
const READS: Route[] = [
  { method: "get", path: "/api/runs/background", ok: 200 },
  { method: "get", path: "/api/runs/background/run_1", ok: 200 },
  { method: "get", path: "/api/runs/group/grp_1", ok: 200 },
];
const WRITES: Route[] = [
  {
    method: "post",
    path: "/api/runs/background",
    body: { projectId: "p1", kind: "chat" },
    ok: 202,
  },
  { method: "post", path: "/api/runs/background/run_1/cancel", ok: 200 },
  { method: "post", path: "/api/runs/background/run_1/pause", ok: 200 },
  { method: "post", path: "/api/runs/background/run_1/resume", ok: 200 },
  {
    method: "post",
    path: "/api/runs/group",
    body: { projectId: "p1", kind: "chat", n: 2 },
    ok: 202,
  },
  { method: "post", path: "/api/runs/run_1/steer", body: { message: "go left" }, ok: 202 },
];

function send(route: Route, token?: string) {
  const r = request(app())[route.method](route.path);
  if (token) r.set("Authorization", `Bearer ${token}`);
  return route.body ? r.send(route.body) : r;
}

afterEach(() => {
  delete process.env.RUNS_LIMIT_MAX;
  delete process.env.RUNS_WRITE_LIMIT_MAX;
  delete process.env.RUNS_PREAUTH_LIMIT_MAX;
});

describe("#1116 backgroundRunsRouter — every route is rate limited", () => {
  it("every route has the pre-auth guard ahead of requireAuth and a per-user budget after it", () => {
    type Layer = { route?: { path: string; methods: object; stack: Array<{ handle: unknown }> } };
    const routes = (backgroundRunsRouter() as unknown as { stack: Layer[] }).stack
      .map((l) => l.route)
      .filter((r): r is NonNullable<Layer["route"]> => Boolean(r));
    expect(routes).toHaveLength(READS.length + WRITES.length);
    for (const route of routes) {
      const chain = route.stack.map((s) => s.handle);
      const isWrite = "post" in route.methods;
      expect(chain[0], `${route.path}`).toBe(limits.runsPreAuthRateLimiter);
      expect(chain[1], `${route.path}`).toBe(requireAuth);
      expect(chain[2], `${route.path}`).toBe(
        isWrite ? limits.runsWriteUserRateLimiter : limits.runsUserRateLimiter,
      );
    }
  });

  it.each(READS)(
    "$method $path: served within the read budget, 429 past it, another user unaffected",
    async (route) => {
      process.env.RUNS_LIMIT_MAX = "2";
      const me = tokenFor(`u-read-${route.path}`);
      expect((await send(route, me)).status).toBe(route.ok);
      expect((await send(route, me)).status).toBe(route.ok);
      const refused = await send(route, me);
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe("RUNS_RATE_LIMITED");
      expect((await send(route, tokenFor(`u-other-${route.path}`))).status).toBe(route.ok);
    },
  );

  it.each(WRITES)(
    "$method $path: served within the write budget, 429 past it, another user unaffected",
    async (route) => {
      process.env.RUNS_WRITE_LIMIT_MAX = "2";
      const me = tokenFor(`u-write-${route.path}`);
      expect((await send(route, me)).status).toBe(route.ok);
      expect((await send(route, me)).status).toBe(route.ok);
      const refused = await send(route, me);
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe("RUNS_RATE_LIMITED");
      expect((await send(route, tokenFor(`u-other-${route.path}`))).status).toBe(route.ok);
    },
  );

  it("reads and writes are separate budgets: spending one leaves the other", async () => {
    process.env.RUNS_LIMIT_MAX = "1";
    process.env.RUNS_WRITE_LIMIT_MAX = "1";
    const me = tokenFor("u-split");
    expect((await send(READS[0]!, me)).status).toBe(200);
    expect((await send(READS[0]!, me)).status).toBe(429);
    expect((await send(WRITES[1]!, me)).status).toBe(200);
    expect((await send(WRITES[1]!, me)).status).toBe(429);
  });

  it("the budget cannot be dodged with a forwarded address", async () => {
    process.env.RUNS_WRITE_LIMIT_MAX = "1";
    const me = tokenFor("u-xff");
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await send(WRITES[1]!, me).set("X-Forwarded-For", `198.51.100.${i}`)).status);
    }
    expect(statuses).toEqual([200, 429, 429]);
  });

  it("an anonymous caller spends no user's budget", async () => {
    process.env.RUNS_WRITE_LIMIT_MAX = "1";
    for (let i = 0; i < 3; i += 1) expect((await send(WRITES[1]!)).status).toBe(401);
    expect((await send(WRITES[1]!, tokenFor("u-after-anon"))).status).toBe(200);
  });
});

describe("#1116 the write budget's key", () => {
  it("is the signed-in user, and never the key another /api/runs limiter gives the request", () => {
    const req = {
      headers: {},
      user: { userId: "u-alice" },
      socket: { remoteAddress: "10.0.0.5", remoteFamily: "IPv4" },
    } as unknown as Parameters<typeof limits.runsWriteUserKey>[0];
    expect(limits.runsWriteUserKey(req)).toBe("write:user:u-alice");
    expect(limits.runsWriteUserKey(req)).not.toBe(limits.runsUserKey(req));
    expect(limits.runsWriteUserKey(req)).not.toBe(limits.runsPreAuthKey(req));
  });

  it("the write default is smaller than the read default", () => {
    expect(limits.RUNS_WRITE_DEFAULT_MAX).toBe(300);
    expect(limits.RUNS_WRITE_DEFAULT_MAX).toBeLessThan(limits.RUNS_USER_DEFAULT_MAX);
  });
});
