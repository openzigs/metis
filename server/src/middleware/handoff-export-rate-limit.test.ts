/**
 * #2595 — the per-user cap on PDF hand-off exports: each PDF launches Chromium,
 * the Word export does not and is not counted.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  HANDOFF_PDF_USER_DEFAULT_MAX,
  handoffPdfUserRateLimiter,
} from "./handoff-export-rate-limit.js";

function app(userId: string) {
  const a = express();
  a.use((req, _res, next) => {
    (req as unknown as { user: { userId: string } }).user = { userId };
    next();
  });
  a.use(handoffPdfUserRateLimiter);
  a.get("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.HANDOFF_PDF_LIMIT_MAX;
});

describe("handoffPdfUserRateLimiter", () => {
  it("caps each user's PDF exports and answers 429 with the standard envelope", async () => {
    process.env.HANDOFF_PDF_LIMIT_MAX = "2";
    const a = app("pdf-cap-1");
    expect((await request(a).get("/?format=pdf")).status).toBe(200);
    expect((await request(a).get("/?format=pdf")).status).toBe(200);
    const limited = await request(a).get("/?format=pdf");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      success: false,
      error: {
        code: "HANDOFF_EXPORT_RATE_LIMITED",
        message: "Too many PDF hand-off exports — please try again later",
      },
    });
    // Another user keeps their own budget.
    expect((await request(app("pdf-cap-2")).get("/?format=pdf")).status).toBe(200);
  });

  it("does not count or refuse the Word export", async () => {
    process.env.HANDOFF_PDF_LIMIT_MAX = "1";
    const a = app("pdf-cap-3");
    expect((await request(a).get("/?format=pdf")).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      expect((await request(a).get("/?format=docx")).status).toBe(200);
    }
    expect((await request(a).get("/?format=pdf")).status).toBe(429);
  });

  it("falls back to the default cap on an invalid setting", async () => {
    process.env.HANDOFF_PDF_LIMIT_MAX = "nope";
    const res = await request(app("pdf-default")).get("/?format=pdf");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"] ?? res.headers["ratelimit-policy"]).toContain(
      String(HANDOFF_PDF_USER_DEFAULT_MAX),
    );
  });
});
