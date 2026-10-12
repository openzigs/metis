/**
 * #1007 (review of #1112, cycle 2) — the two `/api/runs` limiters on ONE
 * request. Both use the same store class, so express-rate-limit reads "the same
 * key from both" as one counter incremented twice and logs
 * `ERR_ERL_DOUBLE_COUNT`. Its validations run once per limiter per process, on
 * the first request that reaches it, which is why this has a file (a fresh
 * module, so a fresh process-wide "already validated" state) to itself and
 * makes a signed-in request FIRST.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type Request } from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens } from "../lib/auth/jwt.js";
import { requireAuth } from "./auth.js";
import { runsPreAuthRateLimiter, runsUserRateLimiter } from "./runs-rate-limit.js";

const tokenFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  }).accessToken;

/** The routes' own order: pre-auth limiter, `requireAuth`, user limiter. */
function app() {
  const a = express();
  const remaining = (res: express.Response) => Number(res.getHeader("RateLimit-Remaining"));
  a.get(
    "/",
    runsPreAuthRateLimiter,
    (_req, res, next) => {
      res.locals.preAuthRemaining = remaining(res);
      next();
    },
    requireAuth,
    runsUserRateLimiter,
    (req: Request, res) => {
      res.json({
        userId: req.user?.userId,
        preAuthRemaining: res.locals.preAuthRemaining as number,
        userRemaining: remaining(res),
      });
    },
  );
  return a;
}

describe("the two /api/runs limiters on one signed-in request", () => {
  afterEach(() => {
    delete process.env.RUNS_LIMIT_MAX;
    delete process.env.RUNS_PREAUTH_LIMIT_MAX;
    vi.restoreAllMocks();
  });

  it("count it once each, and express-rate-limit reports no double count", async () => {
    process.env.RUNS_PREAUTH_LIMIT_MAX = "10";
    process.env.RUNS_LIMIT_MAX = "5";
    const logged: string[] = [];
    const record = (...args: unknown[]) => {
      logged.push(
        args
          .map((a) =>
            a instanceof Error ? `${(a as { code?: string }).code} ${a.message}` : String(a),
          )
          .join(" "),
      );
    };
    vi.spyOn(console, "error").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);

    const bearer = `Bearer ${tokenFor("u-double")}`;
    const first = await request(app()).get("/").set("Authorization", bearer);
    expect(first.status).toBe(200);
    // One hit on each limiter, not two on either.
    expect(first.body).toEqual({ userId: "u-double", preAuthRemaining: 9, userRemaining: 4 });

    const second = await request(app()).get("/").set("Authorization", bearer);
    expect(second.body).toEqual({ userId: "u-double", preAuthRemaining: 8, userRemaining: 3 });

    expect(logged.filter((line) => line.includes("ERR_ERL_DOUBLE_COUNT"))).toEqual([]);
    expect(logged.filter((line) => line.includes("incremented more than once"))).toEqual([]);
  });
});
