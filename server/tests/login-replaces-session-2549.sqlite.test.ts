/**
 * #2549 — a password sign-in in a browser that still holds another session's
 * cookies replaces that session. Seen once in the 2026-11-15 walkthrough: a
 * sign-in as `coordinator` landed on the dashboard while `/api/auth/me`
 * answered `reader`, the account the browser had used before.
 *
 * Over the real auth routes (cookie-parser included, as `app.ts` mounts it) and
 * a real SQLite database built from the migration chain: only the audit sink is
 * stubbed. Every assertion reads what a browser would send next — the cookies
 * the sign-in set — back through the routes.
 */
import cookieParser from "cookie-parser";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { authRouter } = await import("../src/routes/auth.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { csrfProtection, CSRF_HEADER } = await import("../src/middleware/csrf-protection.js");
const { verifyAccessToken } = await import("../src/lib/auth/jwt.js");
const { revocationStore } = await import("../src/lib/auth/revocation-store.js");

/** The `name=value` of each cookie a response set, by name. */
function setCookies(res: request.Response): Record<string, string> {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  const out: Record<string, string> = {};
  for (const line of raw ?? []) {
    const [pair] = line.split(";");
    const eq = pair!.indexOf("=");
    out[pair!.slice(0, eq)] = pair!.slice(eq + 1);
  }
  return out;
}

const cookieHeader = (c: Record<string, string>) =>
  Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2549 — a password sign-in replaces the session the browser already holds",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    // As `app.ts` mounts them: cookie-parser, then the CSRF guard (#913).
    const app = () => {
      const a = express();
      a.use(express.json());
      a.use(cookieParser());
      a.use(csrfProtection());
      a.use("/api/auth", authRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    /** A cookie-borne request as the UI proxy sends it: with the CSRF header. */
    const withCookies = (req: request.Test, cookies: Record<string, string>) =>
      req.set("Cookie", cookieHeader(cookies)).set(CSRF_HEADER, "1");
    const signIn = (username: string, cookies?: Record<string, string>) => {
      const req = request(app()).post("/api/auth/login");
      return (cookies ? withCookies(req, cookies) : req).send({ username, password: "password" });
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2549-login-replaces-session");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("sets both cookies to the new account, and /me then answers the new account", async () => {
      const before = await signIn("reader");
      expect(before.status, before.text).toBe(200);
      const readerCookies = setCookies(before);
      expect(Object.keys(readerCookies).sort()).toEqual(["accessToken", "refreshToken"]);

      const res = await signIn("coordinator", readerCookies);
      expect(res.status, res.text).toBe(200);
      const next = setCookies(res);
      expect(Object.keys(next).sort()).toEqual(["accessToken", "refreshToken"]);
      expect(next.accessToken).not.toBe(readerCookies.accessToken);
      expect(next.refreshToken).not.toBe(readerCookies.refreshToken);
      expect(verifyAccessToken(next.accessToken!).role).toBe("coordinator");

      // What the browser sends next: the cookies the sign-in just set.
      const me = await withCookies(request(app()).get("/api/auth/me"), next);
      expect(me.status, me.text).toBe(200);
      expect(me.body.data.user.username).toBe("coordinator");
      expect(me.body.data.user.role).toBe("coordinator");
    });

    it("ends the replaced session: its refresh token no longer mints a pair", async () => {
      const readerCookies = setCookies(await signIn("reader"));
      expect((await signIn("coordinator", readerCookies)).status).toBe(200);

      // A refresh started under the old session and answered after the sign-in
      // would otherwise put `reader` back in this browser's cookies.
      const late = await withCookies(request(app()).post("/api/auth/refresh"), {
        refreshToken: readerCookies.refreshToken!,
      });
      expect(late.status).toBe(401);
      expect(setCookies(late)).toEqual({});
    });

    it("leaves a session the sign-in did not carry alone", async () => {
      const elsewhere = setCookies(await signIn("reader"));
      expect((await signIn("coordinator")).status).toBe(200);
      const refreshed = await withCookies(request(app()).post("/api/auth/refresh"), {
        refreshToken: elsewhere.refreshToken!,
      });
      expect(refreshed.status, refreshed.text).toBe(200);
    });

    it("signs in whatever the stale cookie is: garbage, or a store that cannot be read", async () => {
      const garbage = await signIn("coordinator", { refreshToken: "not-a-token" });
      expect(garbage.status, garbage.text).toBe(200);

      const readerCookies = setCookies(await signIn("reader"));
      const spy = vi
        .spyOn(revocationStore, "revokeToken")
        .mockRejectedValueOnce(new Error("database unavailable"));
      try {
        const res = await signIn("coordinator", readerCookies);
        expect(res.status, res.text).toBe(200);
        expect(verifyAccessToken(setCookies(res).accessToken!).role).toBe("coordinator");
      } finally {
        spy.mockRestore();
      }
    });
  },
);
