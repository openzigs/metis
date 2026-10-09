/**
 * #953 — the `speckit.taskstoissues` limiters: the pre-auth one caps the
 * command by client address, the live one caps live exports per user, and both
 * leave every other Spec Kit command alone. The limiters are module-level
 * (CodeQL must see the `rateLimit()` result), so budgets are shared across the
 * tests in this file; each test uses its own user or a fresh cap.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  SPECKIT_EXPORT_LIVE_DEFAULT_MAX,
  specKitExportLiveRateLimiter,
  specKitExportPreAuthRateLimiter,
} from "./spec-kit-export-rate-limit.js";

function app() {
  const a = express();
  a.use(express.json());
  a.post(
    "/commands/:cmd",
    specKitExportPreAuthRateLimiter,
    (req, _res, next) => {
      const user = req.header("x-user");
      if (user) (req as unknown as { user: { userId: string } }).user = { userId: user };
      next();
    },
    specKitExportLiveRateLimiter,
    (_req, res) => {
      res.status(200).json({ ok: true });
    },
  );
  return a;
}

afterEach(() => {
  delete process.env.SPECKIT_EXPORT_PREAUTH_LIMIT_MAX;
  delete process.env.SPECKIT_EXPORT_LIVE_LIMIT_MAX;
});

describe("specKitExportLiveRateLimiter", () => {
  it("caps live exports per user, with the standard envelope", async () => {
    process.env.SPECKIT_EXPORT_LIVE_LIMIT_MAX = "2";
    const a = app();
    const live = () =>
      request(a)
        .post("/commands/speckit.taskstoissues")
        .set("x-user", "alice")
        .send({ featureSlug: "001-foo" });
    expect((await live()).status).toBe(200);
    expect((await live()).status).toBe(200);
    const limited = await live();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("SPECKIT_EXPORT_RATE_LIMITED");
    // Another user from the same address has their own budget.
    const bob = await request(a)
      .post("/commands/speckit.taskstoissues")
      .set("x-user", "bob")
      .send({ featureSlug: "001-foo", dryRun: false });
    expect(bob.status).toBe(200);
  });

  it("does not count dry runs or other commands", async () => {
    process.env.SPECKIT_EXPORT_LIVE_LIMIT_MAX = "1";
    const a = app();
    for (let i = 0; i < 3; i++) {
      const dry = await request(a)
        .post("/commands/speckit.taskstoissues")
        .set("x-user", "carol")
        .send({ featureSlug: "001-foo", dryRun: true });
      expect(dry.status).toBe(200);
      const other = await request(a)
        .post("/commands/speckit.plan")
        .set("x-user", "carol")
        .send({ featureSlug: "001-foo" });
      expect(other.status).toBe(200);
    }
    expect(SPECKIT_EXPORT_LIVE_DEFAULT_MAX).toBeGreaterThan(1);
  });
});

describe("specKitExportPreAuthRateLimiter", () => {
  it("caps the export command by client address, and skips every other command", async () => {
    process.env.SPECKIT_EXPORT_PREAUTH_LIMIT_MAX = "1";
    const a = app();
    // The address has spent its budget in the tests above; a cap of 1 is hit.
    const limited = await request(a)
      .post("/commands/speckit.taskstoissues")
      .send({ featureSlug: "001-foo", dryRun: true });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("SPECKIT_EXPORT_RATE_LIMITED");
    const other = await request(a).post("/commands/speckit.plan").send({});
    expect(other.status).toBe(200);
  });
});
