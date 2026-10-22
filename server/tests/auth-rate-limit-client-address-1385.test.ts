/**
 * #1385 — the `/api/auth/*` limiters behind the UI's Next.js proxy.
 *
 * Every browser login reaches the API from the UI pod, whose request carries no
 * client address, so the address limiter was ONE bucket for the whole
 * organisation: one client's 20 wrong passwords locked every user out. The UI
 * now sends the client address signed with `METIS_UI_PROXY_SECRET`; the API
 * keys on it only when the signature verifies, and otherwise on the TCP peer —
 * never on a forgeable `X-Forwarded-For`. A second limiter caps FAILED logins
 * per account, whatever address they come from.
 *
 * Every request here comes from one TCP peer (supertest on loopback), exactly
 * like every request from one UI pod.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createAuthRateLimiter } from "../src/middleware/rate-limit.js";
import { authAccountKey, createAuthAccountGuard } from "../src/lib/auth/login-account-guard.js";
import { InMemoryRateLimitStore } from "../src/lib/discussions/rate-limit-store.js";
import {
  CLIENT_ADDRESS_HEADER,
  CLIENT_ADDRESS_SIGNATURE_HEADER,
  authAddressKey,
  clientAddressSignature,
  signingMinute,
  verifiedClientAddress,
  warnIfNoUiProxySecret,
} from "../src/middleware/auth-client-address.js";
import { clusterRateLimitStore } from "../src/middleware/cluster-rate-limit-store.js";
import { parseTrustProxy } from "../src/app.js";

const SECRET = "a-test-ui-proxy-secret-that-is-long-enough-0123456789";

beforeEach(() => {
  process.env.METIS_UI_PROXY_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.METIS_UI_PROXY_SECRET;
});

/**
 * The address limiter where `routes/index.ts` mounts it, and the account guard
 * where `routes/auth.ts` mounts it — on the login route itself — before a
 * stand-in login that records a failure the way the real handler does.
 */
function harness(
  options: { addressMax?: number; accountMax?: number; clock?: { now: number } } = {},
) {
  const clock = options.clock ?? { now: 1_700_000_000_000 };
  const guard = createAuthAccountGuard({
    max: options.accountMax ?? 10,
    windowMs: 15 * 60_000,
    store: new InMemoryRateLimitStore(),
    now: () => clock.now,
  });
  const app = express();
  // Production's default: trust one proxy hop, so `req.ip` IS the client-written
  // X-Forwarded-For on a direct request — the value that must never buy a bucket.
  app.set("trust proxy", parseTrustProxy(undefined));
  app.use(express.json());
  app.use(
    "/auth",
    createAuthRateLimiter({
      max: options.addressMax ?? 20,
      store: clusterRateLimitStore("auth-1385", { now: () => 1_700_000_000_000 }),
    }),
    (() => {
      const r = express.Router();
      r.post("/login", guard.check, async (req, res) => {
        const body = req.body as { username?: string; password?: string } | undefined;
        if (body?.password === "right") {
          res.status(200).json({ success: true });
          return;
        }
        await guard.recordFailure(body?.username);
        res.status(401).json({ success: false });
      });
      r.post("/refresh", (_req, res) => {
        res.status(401).json({ success: false });
      });
      return r;
    })(),
  );
  return app;
}

/** A login as the UI proxy sends it: the client address, signed. */
function viaUi(app: express.Express, clientIp: string, username = "alice", password = "wrong") {
  return request(app)
    .post("/auth/login")
    .set(CLIENT_ADDRESS_HEADER, clientIp)
    .set(CLIENT_ADDRESS_SIGNATURE_HEADER, clientAddressSignature(SECRET, clientIp))
    .send({ username, password });
}

describe("address limiter behind the UI proxy (#1385)", () => {
  it("one client's failed logins do not block another client behind the same UI pod", async () => {
    const app = harness({ addressMax: 3, accountMax: 1000 });
    for (let i = 0; i < 3; i += 1) {
      expect((await viaUi(app, "203.0.113.7", `user${i}`)).status).toBe(401);
    }
    expect((await viaUi(app, "203.0.113.7", "user9")).status).toBe(429);
    // Same TCP peer (the UI pod), different client: its own budget.
    expect((await viaUi(app, "198.51.100.20", "bob")).status).toBe(401);
  });

  it("a forged X-Forwarded-For does not buy a fresh bucket", async () => {
    const app = harness({ addressMax: 3, accountMax: 1000 });
    const forged = (n: number) =>
      request(app)
        .post("/auth/login")
        .set("X-Forwarded-For", `192.0.2.${n}`)
        .send({ username: `user${n}`, password: "wrong" });
    expect((await forged(1)).status).toBe(401);
    expect((await forged(2)).status).toBe(401);
    expect((await forged(3)).status).toBe(401);
    expect((await forged(4)).status).toBe(429);
  });

  it("an unsigned or wrongly signed client address does not buy a fresh bucket", async () => {
    const app = harness({ addressMax: 2, accountMax: 1000 });
    const send = (ip: string, signature: string | null) => {
      const req = request(app).post("/auth/login").set(CLIENT_ADDRESS_HEADER, ip);
      if (signature !== null) req.set(CLIENT_ADDRESS_SIGNATURE_HEADER, signature);
      return req.send({ username: `u-${ip}`, password: "wrong" });
    };
    expect((await send("192.0.2.1", null)).status).toBe(401);
    expect(
      (
        await send(
          "192.0.2.2",
          clientAddressSignature("some-other-secret-of-length-32+!!", "192.0.2.2"),
        )
      ).status,
    ).toBe(401);
    // A valid signature for ANOTHER address does not vouch for this one.
    expect((await send("192.0.2.3", clientAddressSignature(SECRET, "192.0.2.99"))).status).toBe(
      429,
    );
  });

  it("ignores a signed address when the API holds no secret", async () => {
    const app = harness({ addressMax: 1, accountMax: 1000 });
    delete process.env.METIS_UI_PROXY_SECRET;
    expect((await viaUi(app, "203.0.113.1", "a")).status).toBe(401);
    expect((await viaUi(app, "203.0.113.2", "b")).status).toBe(429);
  });
});

describe("per-account login guard (#1385)", () => {
  it("caps FAILED logins for one account across many addresses", async () => {
    const app = harness({ addressMax: 1000, accountMax: 3 });
    for (let i = 1; i <= 3; i += 1) {
      expect((await viaUi(app, `203.0.113.${i}`, "alice")).status).toBe(401);
    }
    const res = await viaUi(app, "203.0.113.50", "alice");
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/this account/);
    // Even the right password waits out the window: the cap is checked first.
    expect((await viaUi(app, "203.0.113.52", "alice", "right")).status).toBe(429);
    // Folded: the same account however it is spelt, NFKC included.
    expect((await viaUi(app, "203.0.113.51", "  ALICE ")).status).toBe(429);
    expect((await viaUi(app, "203.0.113.51", "\uFF41lice")).status).toBe(429); // full-width a
    // Another account is untouched.
    expect((await viaUi(app, "203.0.113.50", "bob")).status).toBe(401);
  });

  it("never counts a successful sign-in", async () => {
    const app = harness({ addressMax: 1000, accountMax: 2 });
    for (let i = 0; i < 6; i += 1) {
      expect((await viaUi(app, "203.0.113.9", "carol", "right")).status).toBe(200);
    }
    expect((await viaUi(app, "203.0.113.9", "carol")).status).toBe(401);
    expect((await viaUi(app, "203.0.113.9", "carol")).status).toBe(401);
    expect((await viaUi(app, "203.0.113.9", "carol")).status).toBe(429);
  });

  it("frees the account when the window passes", async () => {
    const clock = { now: 1_700_000_000_000 };
    const app = harness({ addressMax: 1000, accountMax: 1, clock });
    expect((await viaUi(app, "203.0.113.9", "erin")).status).toBe(401);
    expect((await viaUi(app, "203.0.113.9", "erin")).status).toBe(429);
    clock.now += 15 * 60_000 + 1;
    expect((await viaUi(app, "203.0.113.9", "erin", "right")).status).toBe(200);
  });

  it("does not throttle other auth routes, or a login that names no account", async () => {
    const app = harness({ addressMax: 1000, accountMax: 1 });
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).post("/auth/refresh").send({ username: "dave" })).status).toBe(
        401,
      );
      expect((await request(app).post("/auth/login").send({})).status).toBe(401);
    }
    expect((await viaUi(app, "203.0.113.9", "dave", "right")).status).toBe(200);
  });

  it("keys a usable username, NFKC-folded and hashed", () => {
    expect(authAccountKey("alice")).toMatch(/^auth-account:[0-9a-f]{64}$/);
    expect(authAccountKey("Alice ")).toBe(authAccountKey("alice"));
    expect(authAccountKey("\u212Aate")).toBe(authAccountKey("kate")); // Kelvin sign
    expect(authAccountKey(42)).toBeNull();
    expect(authAccountKey("   ")).toBeNull();
    expect(authAccountKey("x".repeat(300))).toBeNull();
    expect(authAccountKey(undefined)).toBeNull();
  });

  it("a store error on the check is the error handler's, and on a record is swallowed", async () => {
    const broken = {
      hit: async () => {
        throw new Error("store down");
      },
      count: async () => {
        throw new Error("store down");
      },
      reset: async () => {},
    };
    const guard = createAuthAccountGuard({ store: broken, max: 1 });
    await expect(guard.recordFailure("x")).resolves.toBeUndefined();
    const next = await new Promise<unknown>((resolve) =>
      guard.check(
        { body: { username: "x" } } as unknown as express.Request,
        {} as express.Response,
        resolve,
      ),
    );
    expect(next).toBeInstanceOf(Error);
  });

  it("a store without count() counts every attempt — stricter, never looser", async () => {
    const memory = new InMemoryRateLimitStore();
    const store = { hit: memory.hit.bind(memory), reset: memory.reset.bind(memory) };
    const guard = createAuthAccountGuard({ store, max: 2, now: () => 1 });
    const run = () =>
      new Promise<number | "next">((resolve) =>
        guard.check(
          { body: { username: "y" } } as unknown as express.Request,
          {
            status: (code: number) => ({ json: () => resolve(code) }),
          } as unknown as express.Response,
          () => resolve("next"),
        ),
      );
    expect(await run()).toBe("next");
    expect(await run()).toBe("next");
    expect(await run()).toBe(429);
  });
});

describe("authAddressKey / verifiedClientAddress (#1385)", () => {
  const fakeReq = (headers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({
      headers,
      path: "/login",
      ip: "192.0.2.200",
      socket: { remoteAddress: "10.0.0.5" },
      ...extra,
    }) as unknown as express.Request;

  it("returns the signed address only for a valid IP and a well-formed signature", () => {
    const sig = clientAddressSignature(SECRET, "2001:db8::1");
    expect(
      verifiedClientAddress(
        fakeReq({ [CLIENT_ADDRESS_HEADER]: "2001:db8::1", [CLIENT_ADDRESS_SIGNATURE_HEADER]: sig }),
      ),
    ).toBe("2001:db8::1");
    expect(
      verifiedClientAddress(
        fakeReq({
          [CLIENT_ADDRESS_HEADER]: "2001:db8::1",
          [CLIENT_ADDRESS_SIGNATURE_HEADER]: sig.toUpperCase(),
        }),
      ),
    ).toBe("2001:db8::1");
    const notIp = "not-an-ip";
    expect(
      verifiedClientAddress(
        fakeReq({
          [CLIENT_ADDRESS_HEADER]: notIp,
          [CLIENT_ADDRESS_SIGNATURE_HEADER]: clientAddressSignature(SECRET, notIp),
        }),
      ),
    ).toBeNull();
    expect(
      verifiedClientAddress(
        fakeReq({ [CLIENT_ADDRESS_HEADER]: "192.0.2.1", [CLIENT_ADDRESS_SIGNATURE_HEADER]: "abc" }),
      ),
    ).toBeNull();
    expect(
      verifiedClientAddress(
        fakeReq({ [CLIENT_ADDRESS_HEADER]: ["192.0.2.1"], [CLIENT_ADDRESS_SIGNATURE_HEADER]: sig }),
      ),
    ).toBeNull();
  });

  it("accepts a signature from the previous or next minute, not older (bounded replay)", () => {
    const ip = "192.0.2.10";
    const now = signingMinute();
    const at = (minute: number) =>
      verifiedClientAddress(
        fakeReq({
          [CLIENT_ADDRESS_HEADER]: ip,
          [CLIENT_ADDRESS_SIGNATURE_HEADER]: clientAddressSignature(SECRET, ip, minute),
        }),
      );
    expect(at(now - 1)).toBe(ip);
    expect(at(now + 1)).toBe(ip);
    expect(at(now - 2)).toBeNull();
    expect(at(now + 2)).toBeNull();
    expect(at(now - 3)).toBeNull();
    expect(at(now + 3)).toBeNull();
  });

  it("warns at boot in production only, and only without a usable secret", () => {
    const warn = (m: string) => messages.push(m);
    const messages: string[] = [];
    expect(warnIfNoUiProxySecret({ NODE_ENV: "production" }, warn)).toMatch(
      /METIS_UI_PROXY_SECRET/,
    );
    expect(
      warnIfNoUiProxySecret({ NODE_ENV: "production", METIS_UI_PROXY_SECRET: "short" }, warn),
    ).not.toBeNull();
    expect(
      warnIfNoUiProxySecret({ NODE_ENV: "production", METIS_UI_PROXY_SECRET: SECRET }, warn),
    ).toBeNull();
    expect(warnIfNoUiProxySecret({ NODE_ENV: "development" }, warn)).toBeNull();
    expect(messages).toHaveLength(2);
  });

  it("ignores a secret shorter than 32 characters", () => {
    process.env.METIS_UI_PROXY_SECRET = "short";
    const sig = clientAddressSignature("short", "192.0.2.1");
    expect(
      verifiedClientAddress(
        fakeReq({ [CLIENT_ADDRESS_HEADER]: "192.0.2.1", [CLIENT_ADDRESS_SIGNATURE_HEADER]: sig }),
      ),
    ).toBeNull();
  });

  it("keys a credential route on the TCP peer and never on req.ip", () => {
    expect(authAddressKey(fakeReq({}))).toBe("peer:10.0.0.5");
  });

  it("keys an SSO route on req.ip, the address the Ingress appended", () => {
    expect(authAddressKey(fakeReq({}, { path: "/oidc/callback" }))).toBe("sso:192.0.2.200");
    expect(authAddressKey(fakeReq({}, { path: "/saml/acs" }))).toBe("sso:192.0.2.200");
  });

  it("folds an IPv6 client to its /64", () => {
    const ip = "2001:db8:1:2:3:4:5:6";
    const key = authAddressKey(
      fakeReq({
        [CLIENT_ADDRESS_HEADER]: ip,
        [CLIENT_ADDRESS_SIGNATURE_HEADER]: clientAddressSignature(SECRET, ip),
      }),
    );
    expect(key).toBe("addr:2001:db8:1:2::/64");
  });
});
