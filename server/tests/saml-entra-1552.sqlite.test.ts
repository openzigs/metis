/**
 * #1552 — an Entra ID SAML sign-in through the real ACS route, against a real
 * (migrated SQLite) database: METIS's AuthnRequest, an Entra-shaped signed
 * Response carrying that request's id, and the session the route issues.
 *
 *   - a group object id mapped to a METIS role yields that role;
 *   - a groups overage signs the user in with the default role, and the admin
 *     endpoint behind the Authentication page's warning reports it (read back
 *     from the real audit table);
 *   - the sign-in's MFA result reaches the session token (and survives a
 *     refresh), so `requireMfa` refuses a password-only session;
 *   - Entra's default assertion-only signing is refused with the setting named.
 */
import type { NextFunction, Request, Response } from "express";
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

const { createApp } = await import("../src/app.js");
const { upsertProvider, __resetProviders } = await import("../src/lib/auth/sso-config.js");
const { __resetSAMLInstances } = await import("../src/lib/auth/saml-provider.js");
const { verifyAccessToken } = await import("../src/lib/auth/jwt.js");
const { requireMfa } = await import("../src/lib/auth/require-mfa.js");
const helpers = await import("../src/lib/auth/__tests__/saml-test-helpers.js");
const entra = await import("../src/lib/auth/__tests__/entra-saml-fixtures.js");

const UI_ORIGIN = "https://metis.test";
const ACS_URL = `${UI_ORIGIN}/api/auth/saml/acs`;
const ENTITY_ID = `${UI_ORIGIN}/api/auth/saml/metadata`;

function cookieValue(res: request.Response, name: string): string {
  const raw = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
  const line = raw.find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`cookie ${name} missing`);
  return decodeURIComponent(line.slice(line.indexOf("=") + 1, line.indexOf(";")));
}

/** `requireMfa`'s verdict on a session token: undefined when it lets the request through. */
function requireMfaVerdict(accessToken: string): unknown {
  const next = vi.fn();
  requireMfa(
    { user: verifyAccessToken(accessToken) } as unknown as Request,
    {} as Response,
    next as NextFunction,
  );
  expect(next).toHaveBeenCalledTimes(1);
  return next.mock.calls[0][0];
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1552 — Entra ID SAML sign-in through the ACS (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let app: Application;
    const previousCors = process.env.CORS_ORIGIN;
    const key = helpers.getTestSigningKey();

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1552-entra");
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
      __resetSAMLInstances();
    });

    /** Configure SAML from Entra's Federation Metadata XML, as an admin would. */
    async function configureFromEntraMetadata() {
      const { parseIdPMetadata } = await import("../src/lib/auth/saml-provider.js");
      const metadata = entra.buildEntraFederationMetadata(key);
      const parsed = parseIdPMetadata(metadata);
      upsertProvider({
        mode: "saml",
        name: "Microsoft Entra ID",
        enabled: true,
        groupMappings: [
          { claimValue: entra.ENTRA_GROUP.metisAdmins, role: "admin" },
          { claimValue: entra.ENTRA_GROUP.metisMembers, role: "developer" },
        ],
        defaultRole: "reader",
        saml: {
          entityId: ENTITY_ID,
          acsUrl: ACS_URL,
          idpMetadataXml: metadata,
          idpSsoUrl: parsed.ssoUrl,
          idpCerts: parsed.certs,
          idpIssuer: parsed.issuer,
          signRequests: false,
        },
      });
    }

    /** SP-initiated sign-in: AuthnRequest, then an Entra Response to the ACS. */
    async function signIn(
      user: import("../src/lib/auth/__tests__/entra-saml-fixtures.js").EntraUser,
      signing: "both" | "assertion" = "both",
    ): Promise<request.Response> {
      const start = await request(app).get("/api/auth/saml/login");
      expect(start.status).toBe(302);
      expect(start.headers.location.startsWith(`${entra.ENTRA_SSO_URL}?`)).toBe(true);
      const samlRequest = new URL(start.headers.location).searchParams.get("SAMLRequest")!;
      const requestId = inflateRawSync(Buffer.from(samlRequest, "base64"))
        .toString("utf8")
        .match(/ID="([^"]+)"/)![1];
      const assertionSigned = helpers.signAssertion(
        helpers.buildSamlResponseXml({
          audience: ENTITY_ID,
          recipient: ACS_URL,
          issuer: entra.ENTRA_ISSUER,
          nameId: user.upn,
          inResponseTo: requestId,
          authnContextClassRef: entra.ENTRA_CLASS_REF.password,
          attributes: entra.entraAttributes(user),
        }),
        key,
      );
      const signed =
        signing === "assertion" ? assertionSigned : helpers.signResponse(assertionSigned, key);
      return request(app)
        .post("/api/auth/saml/acs")
        .type("form")
        .send({ SAMLResponse: helpers.toBase64(signed) });
    }

    async function roleOf(acs: request.Response): Promise<string> {
      const me = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${cookieValue(acs, "metis.at")}`);
      expect(me.status).toBe(200);
      return me.body.data.user.role as string;
    }

    it("maps the admin group's object id to admin and the member group's to developer", async () => {
      await configureFromEntraMetadata();
      const admin = await signIn({
        upn: "ada@contoso.example",
        objectId: "ada00000-1552-4000-8000-000000000001",
        displayName: "Ada",
        groups: [entra.ENTRA_GROUP.unrelated, entra.ENTRA_GROUP.metisAdmins],
      });
      expect(admin.status).toBe(302);
      expect(await roleOf(admin)).toBe("admin");

      const member = await signIn({
        upn: "max@contoso.example",
        objectId: "ada00000-1552-4000-8000-000000000002",
        displayName: "Max",
        groups: [entra.ENTRA_GROUP.metisMembers],
      });
      expect(await roleOf(member)).toBe("developer");
    });

    it("a groups overage signs in with the default role and the admin page's endpoint reports it", async () => {
      await configureFromEntraMetadata();
      const admin = await signIn({
        upn: "ada@contoso.example",
        objectId: "ada00000-1552-4000-8000-000000000001",
        displayName: "Ada",
        groups: [entra.ENTRA_GROUP.metisAdmins],
      });
      const adminToken = cookieValue(admin, "metis.at");
      const overageSummary = () =>
        request(app)
          .get("/api/admin/auth/saml/group-overage")
          .set("Authorization", `Bearer ${adminToken}`);
      // Ordinary sign-ins (this test's and the previous one's) record nothing.
      expect((await overageSummary()).body.data).toEqual({ total: 0, recent: [] });

      const acs = await signIn({
        upn: "olga@contoso.example",
        objectId: "ada00000-1552-4000-8000-000000000003",
        displayName: "Olga",
        groupOverage: true,
      });
      expect(acs.status).toBe(302);
      expect(await roleOf(acs)).toBe("reader");

      // The audit write is queued; read it back through the admin endpoint.
      await vi.waitFor(async () => {
        const res = await overageSummary();
        expect(res.status).toBe(200);
        expect(res.body.data.total).toBe(1);
      });
      const summary = (await overageSummary()).body.data;
      expect(summary.recent).toEqual([
        { userId: expect.any(String), username: "olga", at: expect.any(String) },
      ]);

      // Admin-only.
      const olga = await request(app)
        .get("/api/admin/auth/saml/group-overage")
        .set("Authorization", `Bearer ${cookieValue(acs, "metis.at")}`);
      expect(olga.status).toBe(403);
    });

    it("a password-only session is refused by requireMfa, an MFA session is not, across a refresh", async () => {
      await configureFromEntraMetadata();
      const passwordOnly = await signIn({
        upn: "pat@contoso.example",
        objectId: "ada00000-1552-4000-8000-000000000004",
        displayName: "Pat",
        mfa: false,
      });
      const passwordToken = cookieValue(passwordOnly, "metis.at");
      expect(verifyAccessToken(passwordToken).mfaPassed).toBe(false);
      expect(requireMfaVerdict(passwordToken)).toMatchObject({
        statusCode: 403,
        code: "MFA_REQUIRED",
      });

      const refreshed = await request(app)
        .post("/api/auth/refresh")
        .set("X-METIS-CSRF", "1")
        .set("Cookie", `refreshToken=${cookieValue(passwordOnly, "metis.rt")}`);
      expect(refreshed.status).toBe(200);
      expect(requireMfaVerdict(refreshed.body.data.accessToken)).toMatchObject({
        code: "MFA_REQUIRED",
      });

      const withMfa = await signIn({
        upn: "mia@contoso.example",
        objectId: "ada00000-1552-4000-8000-000000000005",
        displayName: "Mia",
        mfa: true,
      });
      const mfaToken = cookieValue(withMfa, "metis.at");
      expect(verifyAccessToken(mfaToken).mfaPassed).toBe(true);
      expect(requireMfaVerdict(mfaToken)).toBeUndefined();
    });

    it("Entra's default assertion-only signing is refused, naming the setting to choose", async () => {
      await configureFromEntraMetadata();
      const acs = await signIn(
        {
          upn: "sam@contoso.example",
          objectId: "ada00000-1552-4000-8000-000000000006",
          displayName: "Sam",
        },
        "assertion",
      );

      expect(acs.status).toBe(401);
      expect(acs.body.error.code).toBe("SAML_AUTH_FAILED");
      expect(acs.body.error.message).toContain('"Sign SAML response and assertion"');
    });
  },
);
