/**
 * #305 — the session skill routes now authorize through `loadAuthorizedSession`
 * (a database read), so each is bounded per IP BEFORE `requireAuth` and per
 * user after it, like every other session route (CodeQL
 * `js/missing-rate-limiting`). Each case uses its own client IP.
 */
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return { prisma: {}, Prisma };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { aiRouter } = await import("../src/routes/ai.js");
const { skillsRouter } = await import("../src/routes/skills.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");

const app = () => {
  const a = express();
  a.set("trust proxy", 1);
  a.use(express.json());
  a.use("/api/ai", aiRouter());
  a.use("/api/skills", skillsRouter());
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
};

describe("#305 session skill routes — pre-auth per-IP rate limit", () => {
  afterEach(() => {
    delete process.env.AI_CONVERSATION_PREAUTH_RATE_LIMIT_MAX;
  });

  it.each([
    ["get", "/api/ai/sessions/s-1/skills", "198.51.100.31"],
    ["post", "/api/ai/sessions/s-1/skills", "198.51.100.32"],
    ["post", "/api/skills/sk-1/load", "198.51.100.33"],
  ] as const)("%s %s — an anonymous flood gets 429 before auth runs", async (method, url, ip) => {
    process.env.AI_CONVERSATION_PREAUTH_RATE_LIMIT_MAX = "2";
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await request(app())[method](url).set("X-Forwarded-For", ip)).status);
    }
    expect(codes).toEqual([401, 401, 429, 429]);
  });
});
