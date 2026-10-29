/**
 * #1539 — the app-wide `/api` limiter: its key, its budget, and how it sits
 * beside the per-route limiters on one request. Mounting on the real app
 * (`/api`, `/metrics`, the unauthenticated token routes) is asserted in
 * `tests/api-rate-limit-app.test.ts`.
 *
 * The first test sends the first request any limiter in this file sees:
 * express-rate-limit runs its `ERR_ERL_DOUBLE_COUNT` validation once per
 * limiter per process, so it must come before every other request here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type Request } from "express";
import request from "supertest";
import rateLimit, { type Store } from "express-rate-limit";
import { getPermissionsForRole } from "@metis/shared";
import { issueTokens } from "../lib/auth/jwt.js";
import { requireAuth } from "./auth.js";
import { runsPreAuthRateLimiter, runsUserRateLimiter } from "./runs-rate-limit.js";
import {
  API_RATE_LIMIT_DEFAULT_MAX,
  apiRateLimitKey,
  apiRateLimitOptions,
  apiRateLimiter,
} from "./api-rate-limit.js";
import {
  CLIENT_ADDRESS_HEADER,
  CLIENT_ADDRESS_SIGNATURE_HEADER,
  clientAddressSignature,
} from "./auth-client-address.js";

const SECRET = "s".repeat(40);

const tokenFor = (userId: string) =>
  issueTokens({
    userId,
    username: userId,
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  }).accessToken;

/** A request as the key function sees it. `ip` is what a forged header would make it. */
const req = (over: {
  authorization?: string;
  cookie?: string;
  peer?: string;
  headers?: Record<string, string>;
}): Request =>
  ({
    ip: "203.0.113.200",
    headers: {
      "x-forwarded-for": "203.0.113.200",
      ...(over.authorization ? { authorization: over.authorization } : {}),
      ...over.headers,
    },
    cookies: over.cookie ? { accessToken: over.cookie } : {},
    socket: { remoteAddress: over.peer ?? "10.0.0.5", remoteFamily: "IPv4" },
  }) as unknown as Request;

/** A limiter-fronted route that never checks auth, like `/api/source`. */
function appWith(limiter: express.RequestHandler) {
  const a = express();
  a.get("/open", limiter, (_req, res) => {
    res.json({ ok: true });
  });
  return a;
}

afterEach(() => {
  delete process.env.API_RATE_LIMIT_MAX;
  delete process.env.API_RATE_LIMIT_PEER_MAX;
  delete process.env.METIS_UI_PROXY_SECRET;
  delete process.env.RUNS_LIMIT_MAX;
  delete process.env.RUNS_PREAUTH_LIMIT_MAX;
  vi.restoreAllMocks();
});

describe("on one request with the /api/runs limiters (same store class)", () => {
  it("each counts once and express-rate-limit reports no double count", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    const a = express();
    a.get(
      "/",
      apiRateLimiter,
      runsPreAuthRateLimiter,
      requireAuth,
      runsUserRateLimiter,
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    const res = await request(a)
      .get("/")
      .set("Authorization", `Bearer ${tokenFor("u-double")}`);
    expect(res.status).toBe(200);
    expect(logged.join("\n")).not.toMatch(/ERR_ERL_DOUBLE_COUNT/);
  });
});

describe("apiRateLimitKey — the user, never an address the caller writes", () => {
  it("a token this server signed is its user, from the header or the cookie, on any peer", () => {
    const token = tokenFor("u-alice");
    expect(apiRateLimitKey(req({ authorization: `Bearer ${token}` }))).toBe("api:user:u-alice");
    expect(apiRateLimitKey(req({ cookie: token, peer: "10.9.9.9" }))).toBe("api:user:u-alice");
  });

  it("two users behind the one UI proxy peer get two keys", () => {
    const alice = apiRateLimitKey(req({ authorization: `Bearer ${tokenFor("u-a")}` }));
    const bob = apiRateLimitKey(req({ authorization: `Bearer ${tokenFor("u-b")}` }));
    expect(alice).not.toBe(bob);
  });

  it("an unsigned or forged token is the TCP peer, never req.ip or X-Forwarded-For", () => {
    expect(apiRateLimitKey(req({ authorization: "Bearer not-a-jwt", peer: "10.0.0.7" }))).toBe(
      "api:peer:10.0.0.7",
    );
    expect(apiRateLimitKey(req({ peer: "10.0.0.7" }))).toBe("api:peer:10.0.0.7");
  });

  it("an anonymous request with a client address the UI signed is that address", () => {
    process.env.METIS_UI_PROXY_SECRET = SECRET;
    const signed = req({
      headers: {
        [CLIENT_ADDRESS_HEADER]: "198.51.100.4",
        [CLIENT_ADDRESS_SIGNATURE_HEADER]: clientAddressSignature(SECRET, "198.51.100.4"),
      },
    });
    expect(apiRateLimitKey(signed)).toBe("api:addr:198.51.100.4");
  });

  it("a client address with a bad signature is ignored for the peer", () => {
    process.env.METIS_UI_PROXY_SECRET = SECRET;
    const forged = req({
      peer: "10.0.0.8",
      headers: {
        [CLIENT_ADDRESS_HEADER]: "198.51.100.4",
        [CLIENT_ADDRESS_SIGNATURE_HEADER]: "0".repeat(64),
      },
    });
    expect(apiRateLimitKey(forged)).toBe("api:peer:10.0.0.8");
  });

  it("every key is under api:, apart from every other limiter's", () => {
    for (const r of [
      req({ authorization: `Bearer ${tokenFor("u-c")}` }),
      req({ peer: "10.1.1.1" }),
    ]) {
      expect(apiRateLimitKey(r)).toMatch(/^api:/);
    }
  });
});

describe("apiRateLimiter — the budget", () => {
  it("defaults to a few hundred a window", () => {
    expect(API_RATE_LIMIT_DEFAULT_MAX).toBe(600);
  });

  it("a burst over API_RATE_LIMIT_MAX on an otherwise unlimited route is 429", async () => {
    process.env.API_RATE_LIMIT_MAX = "3";
    const a = appWith(apiRateLimiter);
    const auth = `Bearer ${tokenFor("u-burst")}`;
    for (let i = 0; i < 3; i++) {
      expect((await request(a).get("/open").set("Authorization", auth)).status).toBe(200);
    }
    const res = await request(a).get("/open").set("Authorization", auth);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("API_RATE_LIMITED");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("two users from the one peer do not share a bucket", async () => {
    process.env.API_RATE_LIMIT_MAX = "2";
    const a = appWith(apiRateLimiter);
    const alice = `Bearer ${tokenFor("u-alice-2")}`;
    const bob = `Bearer ${tokenFor("u-bob-2")}`;
    await request(a).get("/open").set("Authorization", alice);
    await request(a).get("/open").set("Authorization", alice);
    expect((await request(a).get("/open").set("Authorization", alice)).status).toBe(429);
    expect((await request(a).get("/open").set("Authorization", bob)).status).toBe(200);
  });

  it("a spent user bucket does not spend the anonymous one, nor the other way", async () => {
    process.env.API_RATE_LIMIT_MAX = "1";
    process.env.API_RATE_LIMIT_PEER_MAX = "1";
    const a = appWith(apiRateLimiter);
    const carol = `Bearer ${tokenFor("u-carol")}`;
    await request(a).get("/open").set("Authorization", carol);
    expect((await request(a).get("/open").set("Authorization", carol)).status).toBe(429);
    expect((await request(a).get("/open")).status).toBe(200);
    expect((await request(a).get("/open")).status).toBe(429);
    expect(
      (
        await request(a)
          .get("/open")
          .set("Authorization", `Bearer ${tokenFor("u-dan")}`)
      ).status,
    ).toBe(200);
  });

  it("lets the request through when the store fails, rather than failing the whole API", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: Store = {
      increment: async () => {
        throw new Error("rate-limit backend down");
      },
      decrement: async () => {},
      resetKey: async () => {},
    };
    const limiter = rateLimit({
      ...apiRateLimitOptions(),
      store: broken,
    }) as unknown as express.RequestHandler;
    expect((await request(appWith(limiter)).get("/open")).status).toBe(200);
  });
});
