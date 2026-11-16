/**
 * #2595 — the per-user cap on hand-off exports. A PDF launches Chromium, and so
 * does a Word export holding a Mermaid diagram, so both formats share one budget.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  HANDOFF_EXPORT_USER_DEFAULT_MAX,
  handoffExportUserRateLimiter,
} from "./handoff-export-rate-limit.js";

function app(userId: string) {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(handoffExportUserRateLimiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.HANDOFF_EXPORT_LIMIT_MAX;
});

describe("handoffExportUserRateLimiter", () => {
  it("caps each user's exports and answers 429 with the standard envelope", async () => {
    process.env.HANDOFF_EXPORT_LIMIT_MAX = "2";
    const a = app("handoff-cap-1");
    expect((await request(a).get("/?format=pdf")).status).toBe(200);
    expect((await request(a).get("/?format=pdf")).status).toBe(200);
    const limited = await request(a).get("/?format=pdf");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      error: {
        code: "HANDOFF_EXPORT_RATE_LIMITED",
        message: "Too many hand-off exports — please try again later",
      },
    });
    // Another user keeps their own budget.
    expect((await request(app("handoff-cap-2")).get("/?format=pdf")).status).toBe(200);
  });

  it("counts the Word export too: a Mermaid diagram in it launches Chromium", async () => {
    process.env.HANDOFF_EXPORT_LIMIT_MAX = "2";
    const a = app("handoff-cap-3");
    expect((await request(a).get("/?format=docx")).status).toBe(200);
    expect((await request(a).get("/?format=pdf")).status).toBe(200);
    expect((await request(a).get("/?format=docx")).status).toBe(429);
  });

  it("falls back to the default cap on an invalid setting", async () => {
    process.env.HANDOFF_EXPORT_LIMIT_MAX = "nope";
    const res = await request(app("handoff-default")).get("/?format=pdf");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"] ?? res.headers["ratelimit-policy"]).toContain(
      String(HANDOFF_EXPORT_USER_DEFAULT_MAX),
    );
  });
});
