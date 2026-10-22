/**
 * #1386 — an SSO login must end in the session the UI reads.
 *
 * The OIDC callback and the SAML ACS set `accessToken` / `refreshToken`, while
 * the UI keeps the browser's session in `metis.at` / `metis.rt`. So an SSO login
 * "succeeded" and landed on a page that bounced the user to `/login`.
 *
 * These drive both logins end to end against a real (migrated SQLite) database:
 *
 *   OIDC — METIS's redirect to an in-process OpenID provider
 *   (`scripts/lib/mock-oidc-idp.mjs`: discovery, authorize, PKCE token
 *   exchange, an RS256 id_token), the IdP's redirect back, the callback, and
 *   then the UI's two uses of the cookies: the access cookie as a Bearer token
 *   (`/api/auth/me`), and the refresh cookie as the upstream refresh token.
 *
 *   SAML — METIS's AuthnRequest redirect, a signed Response to the ACS carrying
 *   that request's id, and the same session checks, under `NODE_ENV=production`
 *   so the cookies' `Secure` attribute is asserted where the Ingress serves them.
 *
 * The Playwright spec `e2e/tests/sso-oidc-session.spec.ts` drives the OIDC flow
 * in a real browser and lands on the signed-in dashboard.
 */
import { inflateRawSync } from "node:zlib";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import type { Application } from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
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

const { createApp } = await import("../src/app.js");
const { upsertProvider, __resetProviders } = await import("../src/lib/auth/sso-config.js");
const { __clearDiscoveryCache } = await import("../src/lib/auth/oidc-provider.js");
const { __resetSAMLInstances } = await import("../src/lib/auth/saml-provider.js");
const helpers = await import("../src/lib/auth/__tests__/saml-test-helpers.js");

interface MockIdp {
  issuer: string;
  discoveryUrl: string;
  calls: { authorize: number; token: number };
  close(): Promise<void>;
}
// A URL specifier: the scripts package ships plain `.mjs` with no declarations.
const mockIdpModule = new URL("../../scripts/lib/mock-oidc-idp.mjs", import.meta.url);
const { startMockOidcIdp } = (await import(mockIdpModule.href)) as {
  startMockOidcIdp(options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    user: {
      sub: string;
      preferredUsername: string;
      email: string;
      name: string;
      groups?: string[];
    };
  }): Promise<MockIdp>;
};

const UI_ORIGIN = "https://metis.test";
const REDIRECT_URI = `${UI_ORIGIN}/api/auth/oidc/callback`;

/** `Set-Cookie` lines by cookie name. */
function cookiesByName(res: request.Response): Map<string, string> {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return new Map((raw ?? []).map((line) => [line.slice(0, line.indexOf("=")), line]));
}

function cookieValue(line: string | undefined): string {
  if (!line) throw new Error("cookie missing");
  return decodeURIComponent(line.slice(line.indexOf("=") + 1, line.indexOf(";")));
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1386 — SSO completion sets the UI's session cookies (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let app: Application;
    const previousCors = process.env.CORS_ORIGIN;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1386-sso");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.CORS_ORIGIN = UI_ORIGIN;
      app = createApp({ corsOrigin: UI_ORIGIN });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      process.env.CORS_ORIGIN = previousCors;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    afterEach(() => {
      __resetProviders();
      __clearDiscoveryCache();
      __resetSAMLInstances();
      vi.unstubAllEnvs();
    });

    /** The UI's two uses of a session: the access cookie as Bearer, the refresh cookie upstream. */
    async function expectUsableSession(
      cookies: Map<string, string>,
      expected: { username: string; role: string },
    ) {
      const me = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${cookieValue(cookies.get("metis.at"))}`);
      expect(me.status).toBe(200);
      expect(me.body.data.user).toMatchObject(expected);

      const refreshed = await request(app)
        .post("/api/auth/refresh")
        .set("X-METIS-CSRF", "1")
        .set("Cookie", `refreshToken=${cookieValue(cookies.get("metis.rt"))}`);
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    }

    it("OIDC: redirect → IdP → callback → the UI's metis.at / metis.rt session", async () => {
      const idp = await startMockOidcIdp({
        clientId: "metis-test",
        clientSecret: "metis-test-secret",
        redirectUri: REDIRECT_URI,
        user: {
          sub: "u-1386",
          preferredUsername: "oidc.alice",
          email: "oidc.alice@example.test",
          name: "OIDC Alice",
          groups: ["metis-admins"],
        },
      });
      try {
        upsertProvider({
          mode: "oidc",
          name: "Mock OIDC",
          enabled: true,
          groupMappings: [{ claimValue: "metis-admins", role: "admin" }],
          defaultRole: "reader",
          oidc: {
            discoveryUrl: idp.discoveryUrl,
            clientId: "metis-test",
            clientSecret: "metis-test-secret",
            redirectUri: REDIRECT_URI,
            scopes: ["openid", "profile", "email"],
            pkceEnabled: true,
          },
        });

        const start = await request(app).get("/api/auth/oidc/login");
        expect(start.status).toBe(302);
        expect(start.headers.location).toMatch(new RegExp(`^${idp.issuer}/authorize\\?`));

        const atIdp = await fetch(start.headers.location, { redirect: "manual" });
        expect(atIdp.status).toBe(302);
        const back = new URL(atIdp.headers.get("location")!);
        expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);

        const callback = await request(app).get(`/api/auth/oidc/callback${back.search}`);
        expect(callback.status).toBe(302);
        expect(callback.headers.location).toBe(`${UI_ORIGIN}/dashboard`);
        expect(idp.calls.token).toBe(1);

        const cookies = cookiesByName(callback);
        expect([...cookies.keys()].sort()).toEqual(["metis.at", "metis.rt"]);
        for (const name of ["metis.at", "metis.rt"]) {
          const line = cookies.get(name)!;
          expect(line).toMatch(/; HttpOnly/);
          expect(line).toMatch(/; SameSite=Lax/);
          expect(line).toMatch(/; Path=\//);
          expect(line).not.toMatch(/; Secure/); // NODE_ENV is "test" here
        }
        expect(cookies.get("metis.at")).toMatch(/Max-Age=3600;/);
        expect(cookies.get("metis.rt")).toMatch(/Max-Age=604800;/);

        await expectUsableSession(cookies, { username: "oidc.alice", role: "admin" });
      } finally {
        await idp.close();
      }
    });

    it("OIDC: a replayed callback is refused and sets no cookie", async () => {
      const idp = await startMockOidcIdp({
        clientId: "metis-test",
        clientSecret: "metis-test-secret",
        redirectUri: REDIRECT_URI,
        user: { sub: "u-2", preferredUsername: "oidc.bob", email: "b@example.test", name: "Bob" },
      });
      try {
        upsertProvider({
          mode: "oidc",
          name: "Mock OIDC",
          enabled: true,
          groupMappings: [],
          defaultRole: "reader",
          oidc: {
            discoveryUrl: idp.discoveryUrl,
            clientId: "metis-test",
            clientSecret: "metis-test-secret",
            redirectUri: REDIRECT_URI,
            scopes: ["openid", "profile", "email"],
            pkceEnabled: true,
          },
        });
        const start = await request(app).get("/api/auth/oidc/login");
        const atIdp = await fetch(start.headers.location, { redirect: "manual" });
        const search = new URL(atIdp.headers.get("location")!).search;
        expect((await request(app).get(`/api/auth/oidc/callback${search}`)).status).toBe(302);
        const replay = await request(app).get(`/api/auth/oidc/callback${search}`);
        expect(replay.status).toBe(401);
        expect(cookiesByName(replay).size).toBe(0);
      } finally {
        await idp.close();
      }
    });

    it("SAML: AuthnRequest → signed Response at the ACS → Secure session cookies in production", async () => {
      const key = helpers.getTestSigningKey();
      const acsUrl = `${UI_ORIGIN}/api/auth/saml/acs`;
      const entityId = `${UI_ORIGIN}/api/auth/saml/metadata`;
      const idpIssuer = "https://idp.example.test/saml";
      upsertProvider({
        mode: "saml",
        name: "Mock SAML",
        enabled: true,
        groupMappings: [],
        defaultRole: "developer",
        saml: {
          entityId,
          acsUrl,
          idpMetadataXml: "",
          idpSsoUrl: "https://idp.example.test/saml/sso",
          idpCerts: [key.certificateBody],
          idpIssuer,
          signRequests: false,
        },
      });

      const start = await request(app).get("/api/auth/saml/login");
      expect(start.status).toBe(302);
      const samlRequest = new URL(start.headers.location).searchParams.get("SAMLRequest")!;
      const requestId = inflateRawSync(Buffer.from(samlRequest, "base64"))
        .toString("utf8")
        .match(/ID="([^"]+)"/)![1];

      const signed = helpers.signResponse(
        helpers.signAssertion(
          helpers.buildSamlResponseXml({
            audience: entityId,
            recipient: acsUrl,
            issuer: idpIssuer,
            nameId: "saml.carol@example.test",
            inResponseTo: requestId,
          }),
          key,
        ),
        key,
      );

      vi.stubEnv("NODE_ENV", "production");
      const acs = await request(app)
        .post("/api/auth/saml/acs")
        .type("form")
        .send({ SAMLResponse: helpers.toBase64(signed) });
      vi.unstubAllEnvs();

      expect(acs.status).toBe(302);
      expect(acs.headers.location).toBe(`${UI_ORIGIN}/dashboard`);
      const cookies = cookiesByName(acs);
      expect([...cookies.keys()].sort()).toEqual(["metis.at", "metis.rt"]);
      for (const line of cookies.values()) {
        expect(line).toMatch(/; Secure/);
        expect(line).toMatch(/; HttpOnly/);
        expect(line).toMatch(/; SameSite=Lax/);
      }
      const me = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${cookieValue(cookies.get("metis.at"))}`);
      expect(me.status).toBe(200);
      expect(me.body.data.user.role).toBe("developer");
      await expectUsableSession(cookies, {
        username: me.body.data.user.username,
        role: "developer",
      });
    });
  },
);
