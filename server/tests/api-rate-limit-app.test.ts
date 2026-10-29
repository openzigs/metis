/**
 * #1539 — the app-wide limiter as `createApp()` mounts it: first on `/api`, and
 * on the top-level `/metrics` scrape. The key and the budget arithmetic have
 * their own unit test (`src/middleware/api-rate-limit.test.ts`).
 *
 * The limiter is one module-level instance, so its counters outlive each test:
 * every test spends a bucket of its own (its own user, or its own signed client
 * address). Only the last test spends the shared anonymous loopback bucket.
 */
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { getPermissionsForRole } from "@metis/shared";
import { createApp } from "../src/app.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import {
  CLIENT_ADDRESS_HEADER,
  CLIENT_ADDRESS_SIGNATURE_HEADER,
  clientAddressSignature,
} from "../src/middleware/auth-client-address.js";

const SECRET = "p".repeat(40);

const bearerFor = (userId: string) =>
  `Bearer ${
    issueTokens({
      userId,
      username: userId,
      role: "developer",
      permissions: getPermissionsForRole("developer"),
    }).accessToken
  }`;

const app = createApp();

afterEach(() => {
  process.env.API_RATE_LIMIT_MAX = "100000";
  delete process.env.METIS_UI_PROXY_SECRET;
  delete process.env.METRICS_TOKEN;
  delete process.env.API_RATE_LIMIT_PEER_MAX;
});

describe("the app-wide /api limiter on the real app", () => {
  it("a burst over budget on a route with no limiter of its own is 429", async () => {
    process.env.API_RATE_LIMIT_MAX = "3";
    const auth = bearerFor("u-app-burst");
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get("/api/source").set("Authorization", auth)).status).toBe(200);
    }
    const res = await request(app).get("/api/source").set("Authorization", auth);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("API_RATE_LIMITED");
  });

  it("the budget is per user, not per route: a spent user is 429 on another route too", async () => {
    process.env.API_RATE_LIMIT_MAX = "1";
    const auth = bearerFor("u-app-preauth");
    await request(app).get("/api/source").set("Authorization", auth);
    const res = await request(app).get("/api/projects").set("Authorization", auth);
    expect(res.status).toBe(429);
  });

  it("requests through the UI proxy (one peer) are keyed by user: two users, two buckets", async () => {
    process.env.API_RATE_LIMIT_MAX = "2";
    const alice = bearerFor("u-app-alice");
    const bob = bearerFor("u-app-bob");
    await request(app).get("/api/source").set("Authorization", alice);
    await request(app).get("/api/source").set("Authorization", alice);
    expect((await request(app).get("/api/source").set("Authorization", alice)).status).toBe(429);
    expect((await request(app).get("/api/source").set("Authorization", bob)).status).toBe(200);
  });

  it("an anonymous request the UI vouches for is keyed by its signed client address", async () => {
    process.env.API_RATE_LIMIT_MAX = "1";
    process.env.METIS_UI_PROXY_SECRET = SECRET;
    const from = (address: string) =>
      request(app)
        .get("/api/source")
        .set(CLIENT_ADDRESS_HEADER, address)
        .set(CLIENT_ADDRESS_SIGNATURE_HEADER, clientAddressSignature(SECRET, address));
    expect((await from("198.51.100.21")).status).toBe(200);
    expect((await from("198.51.100.21")).status).toBe(429);
    expect((await from("198.51.100.22")).status).toBe(200);
  });

  it("covers the unauthenticated token checks: SCIM, the Slack OAuth callback and /metrics", async () => {
    process.env.API_RATE_LIMIT_MAX = "3";
    process.env.API_RATE_LIMIT_PEER_MAX = "3";
    process.env.METRICS_TOKEN = "metrics-token-for-1539";
    const scim = () =>
      request(app).get("/api/scim/v2/Users").set("Authorization", "Bearer guessed-scim-token");
    const slack = () => request(app).get("/api/integrations/slack/oauth/callback?code=x&state=y");
    const metrics = () => request(app).get("/metrics").set("Authorization", "Bearer guessed");

    // Inside the budget each answers for itself (a refusal, not a 429)…
    expect((await scim()).status).not.toBe(429);
    expect((await slack()).status).not.toBe(429);
    expect((await metrics()).status).toBe(401);
    // …and past it, the guesses stop being checked at all.
    for (const send of [scim, slack, metrics]) {
      const res = await send();
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("API_RATE_LIMITED");
    }
  });
  it("a spent signed-address bucket is 401 for a request whose token resolved to no user, 429 otherwise", async () => {
    process.env.API_RATE_LIMIT_MAX = "1";
    process.env.METIS_UI_PROXY_SECRET = SECRET;
    const from = (address: string, authorization?: string) => {
      const r = request(app)
        .get("/api/source")
        .set(CLIENT_ADDRESS_HEADER, address)
        .set(CLIENT_ADDRESS_SIGNATURE_HEADER, clientAddressSignature(SECRET, address));
      return authorization ? r.set("Authorization", authorization) : r;
    };
    expect((await from("198.51.100.31")).status).toBe(200);
    const expired = await from(
      "198.51.100.31",
      `Bearer ${jwt.sign({ userId: "u-x", exp: 1 }, "some-other-secret")}`,
    );
    expect(expired.status).toBe(401);
    expect(expired.headers["retry-after"]).toBeUndefined();
    const anonymous = await from("198.51.100.31");
    expect(anonymous.status).toBe(429);
    expect(anonymous.body.error.code).toBe("API_RATE_LIMITED");
  });

  it("the shared anonymous peer bucket has its own, larger budget (#1539 review: one client cannot lock out webhooks and /health)", async () => {
    process.env.API_RATE_LIMIT_MAX = "1";
    process.env.API_RATE_LIMIT_PEER_MAX = "100000";
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get(`/api/no-such-route-${i}`)).status).toBe(404);
    }
    expect((await request(app).get("/api/health")).status).not.toBe(429);
    // …and it is still a budget.
    process.env.API_RATE_LIMIT_PEER_MAX = "1";
    expect((await request(app).get("/api/source")).status).toBe(429);
  });
});
