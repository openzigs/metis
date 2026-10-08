/**
 * #941 — the invite-accept limiter: per-IP keys, a cap read per request, and
 * its place ahead of `requireAuth` on the accept route.
 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { INVITE_ACCEPT_DEFAULT_MAX, inviteAcceptRateLimiter } from "./invite-accept-rate-limit.js";
import { requireAuth } from "./auth.js";
import { workspacesRouter } from "../routes/workspaces.js";

function app() {
  const a = express();
  a.use(inviteAcceptRateLimiter);
  a.post("/", (_req, res) => res.json({ ok: true }));
  return a;
}

afterEach(() => {
  delete process.env.INVITE_ACCEPT_RATE_LIMIT_MAX;
});

describe("inviteAcceptRateLimiter (#941)", () => {
  it("caps a caller's IP at INVITE_ACCEPT_RATE_LIMIT_MAX", async () => {
    process.env.INVITE_ACCEPT_RATE_LIMIT_MAX = "2";
    const a = app();
    expect((await request(a).post("/")).status).toBe(200);
    expect((await request(a).post("/")).status).toBe(200);
    const limited = await request(a).post("/");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMIT");
  });

  it("falls back to the default cap on a malformed override", async () => {
    process.env.INVITE_ACCEPT_RATE_LIMIT_MAX = "not-a-number";
    const res = await request(app()).post("/");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe(String(INVITE_ACCEPT_DEFAULT_MAX));
  });

  it("runs ahead of requireAuth on POST /invites/:token/accept", () => {
    type Layer = {
      route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
    };
    const stack = (workspacesRouter() as unknown as { stack: Layer[] }).stack;
    const route = stack.find(
      (l) => l.route?.path === "/invites/:token/accept" && l.route.methods.post,
    )?.route;
    expect(route).toBeDefined();
    const handles = route!.stack.map((s) => s.handle);
    expect(handles[0]).toBe(inviteAcceptRateLimiter);
    expect(handles[1]).toBe(requireAuth);
  });
});
