/**
 * #1006 — the imported-requirements listing limiter: a per-IP cap read per
 * request, with a production default.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  IMPORTED_REQUIREMENTS_DEFAULT_MAX,
  importedRequirementsRateLimiter,
} from "./imported-requirements-rate-limit.js";

function app() {
  const a = express();
  a.use(importedRequirementsRateLimiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.IMPORTED_REQUIREMENTS_RATE_LIMIT_MAX;
});

describe("importedRequirementsRateLimiter (#1006)", () => {
  it("caps a caller at IMPORTED_REQUIREMENTS_RATE_LIMIT_MAX per window", async () => {
    process.env.IMPORTED_REQUIREMENTS_RATE_LIMIT_MAX = "1";
    const a = app();
    expect((await request(a).get("/")).status).toBe(200);
    const limited = await request(a).get("/");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });

  it(`defaults to ${IMPORTED_REQUIREMENTS_DEFAULT_MAX} per window outside tests`, async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const res = await request(app()).get("/");
      expect(res.headers["ratelimit-limit"]).toBe(String(IMPORTED_REQUIREMENTS_DEFAULT_MAX));
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
