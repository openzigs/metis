/**
 * #1553 — METIS against the in-process Entra-profile SAML IdP
 * (`scripts/lib/mock-entra-saml-idp.mjs`), through the real routes and a real
 * (migrated SQLite) database, with no network beyond loopback:
 *
 *   METIS's AuthnRequest redirect → the IdP's SAML endpoint → its auto-posting
 *   form → the ACS → the issued session.
 *
 * The Playwright spec `e2e/tests/sso-saml-entra.spec.ts` drives the same IdP
 * from the login page's SAML button in a real browser; this file covers every
 * profile the IdP offers, quickly, so a mock or METIS regression shows here
 * first.
 */
import type { NextFunction, Request, Response } from "express";
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
const { __resetSAMLInstances, parseIdPMetadata } = await import("../src/lib/auth/saml-provider.js");
const { verifyAccessToken } = await import("../src/lib/auth/jwt.js");
const { requireMfa } = await import("../src/lib/auth/require-mfa.js");

interface EntraUser {
  upn: string;
  objectId: string;
  displayName: string;
  groups?: string[];
  roles?: string[];
}
interface EntraProfile {
  signing: "assertion" | "response" | "both";
  mfa: boolean;
  groupOverage: boolean;
  expired: boolean;
  wrongAudience: boolean;
  issuer: string;
}
interface MockEntraIdp {
  tenantId: string;
  issuer: string;
  ssoUrl: string;
  metadataUrl: string;
  calls: { metadata: number; sso: number };
  lastResponse(): string | undefined;
  setUser(user: EntraUser): void;
  setProfile(profile: Partial<EntraProfile>): void;
  close(): Promise<void>;
}
// A URL specifier: the scripts package ships plain `.mjs` with no declarations.
const mockIdpModule = new URL("../../scripts/lib/mock-entra-saml-idp.mjs", import.meta.url);
const { startMockEntraSamlIdp } = (await import(mockIdpModule.href)) as {
  startMockEntraSamlIdp(options: {
    spEntityId: string;
    acsUrl: string;
    user: EntraUser;
    profile?: Partial<EntraProfile>;
  }): Promise<MockEntraIdp>;
};

const UI_ORIGIN = "https://metis.test";
const ACS_URL = `${UI_ORIGIN}/api/auth/saml/acs`;
const ENTITY_ID = `${UI_ORIGIN}/api/auth/saml/metadata`;
const ADMINS = "6f1d0000-1553-4000-8000-0000000000ad";
const MEMBERS = "6f1d0000-1553-4000-8000-00000000006d";

let userSeq = 0;
/** A new Entra user: #1395 binds an account to issuer + subject, so each is fresh. */
function entraUser(name: string, groups: string[] = []): EntraUser {
  userSeq += 1;
  return {
    upn: `${name}${userSeq}@contoso.example`,
    objectId: `0b1ec700-1553-4000-8000-${String(userSeq).padStart(12, "0")}`,
    displayName: name,
    groups,
  };
}

function cookieValue(res: request.Response, name: string): string {
  const raw = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
  const line = raw.find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`cookie ${name} missing`);
  return decodeURIComponent(line.slice(line.indexOf("=") + 1, line.indexOf(";")));
}

function requireMfaVerdict(accessToken: string): unknown {
  const next = vi.fn();
  requireMfa(
    { user: verifyAccessToken(accessToken) } as unknown as Request,
    {} as Response,
    next as NextFunction,
  );
  return next.mock.calls[0][0];
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1553 — SAML sign-in against the Entra-profile mock IdP (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let app: Application;
    let idp: MockEntraIdp;
    const previousCors = process.env.CORS_ORIGIN;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1553-entra-idp");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.CORS_ORIGIN = UI_ORIGIN;
      app = createApp({ corsOrigin: UI_ORIGIN });
      idp = await startMockEntraSamlIdp({
        spEntityId: ENTITY_ID,
        acsUrl: ACS_URL,
        user: entraUser("nobody"),
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await idp?.close();
      process.env.CORS_ORIGIN = previousCors;
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    afterEach(() => {
      __resetProviders();
      __resetSAMLInstances();
    });

    /** Configure METIS from the IdP's Federation Metadata XML, as an admin pastes it. */
    async function configure() {
      const metadata = await (await fetch(idp.metadataUrl)).text();
      const parsed = parseIdPMetadata(metadata);
      upsertProvider({
        mode: "saml",
        name: "Microsoft Entra ID (mock)",
        enabled: true,
        groupMappings: [
          { claimValue: ADMINS, role: "admin" },
          { claimValue: MEMBERS, role: "developer" },
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
      return parsed;
    }

    /** METIS → IdP → the IdP's auto-posting form → METIS's ACS. */
    async function signIn(user: EntraUser, profile: Partial<EntraProfile>) {
      idp.setUser(user);
      idp.setProfile(profile);
      const start = await request(app).get("/api/auth/saml/login");
      expect(start.status).toBe(302);
      expect(start.headers.location.startsWith(`${idp.ssoUrl}?SAMLRequest=`)).toBe(true);
      const atIdp = await fetch(start.headers.location);
      expect(atIdp.status).toBe(200);
      const html = await atIdp.text();
      expect(html).toContain(`action="${ACS_URL}"`);
      const samlResponse = /name="SAMLResponse" value="([^"]*)"/.exec(html)![1];
      return request(app)
        .post("/api/auth/saml/acs")
        .type("form")
        .send({ SAMLResponse: samlResponse });
    }

    async function roleOf(acs: request.Response) {
      const me = await request(app)
        .get("/api/auth/me")
        .set("Authorization", `Bearer ${cookieValue(acs, "metis.at")}`);
      return me.body.data.user.role as string;
    }

    it("the metadata METIS parses names the IdP's issuer and SAML endpoint", async () => {
      const parsed = await configure();
      expect(parsed.issuer).toBe(idp.issuer);
      expect(parsed.ssoUrl).toBe(idp.ssoUrl);
      expect(parsed.certs).toHaveLength(1);
    });

    it('with "Sign SAML response and assertion", the admin group signs in as admin and the member group as developer', async () => {
      await configure();
      const admin = await signIn(entraUser("ada", [ADMINS]), { signing: "both" });
      expect(admin.status).toBe(302);
      expect(admin.headers.location).toBe(`${UI_ORIGIN}/dashboard`);
      expect(await roleOf(admin)).toBe("admin");

      const member = await signIn(entraUser("max", [MEMBERS]), { signing: "both" });
      expect(await roleOf(member)).toBe("developer");
    });

    it.each([
      ["Entra's default, assertion only", "assertion", /"Sign SAML response and assertion"/],
      ["response only", "response", /Invalid signature/],
    ] as const)("signing %s is refused", async (_label, signing, message) => {
      await configure();
      const acs = await signIn(entraUser("sam", [ADMINS]), { signing });
      expect(acs.status).toBe(401);
      expect(acs.body.error.message).toMatch(message);
    });

    it("a password-only session is refused by requireMfa; an MFA session is not", async () => {
      await configure();
      const password = await signIn(entraUser("pat"), { signing: "both", mfa: false });
      expect(verifyAccessToken(cookieValue(password, "metis.at")).mfaPassed).toBe(false);
      expect(requireMfaVerdict(cookieValue(password, "metis.at"))).toMatchObject({
        code: "MFA_REQUIRED",
      });

      const mfa = await signIn(entraUser("mia"), { signing: "both", mfa: true });
      expect(verifyAccessToken(cookieValue(mfa, "metis.at")).mfaPassed).toBe(true);
      expect(requireMfaVerdict(cookieValue(mfa, "metis.at"))).toBeUndefined();
    });

    it("a groups overage signs in with the default role and reaches the admin warning", async () => {
      await configure();
      const admin = await signIn(entraUser("ada", [ADMINS]), { signing: "both" });
      const overage = await signIn(entraUser("olga", [ADMINS]), {
        signing: "both",
        groupOverage: true,
      });
      expect(overage.status).toBe(302);
      expect(await roleOf(overage)).toBe("reader");
      await vi.waitFor(async () => {
        const summary = await request(app)
          .get("/api/admin/auth/saml/group-overage")
          .set("Authorization", `Bearer ${cookieValue(admin, "metis.at")}`);
        expect(summary.body.data.recent[0]?.username).toMatch(/^olga\d+$/);
      });
    });

    it("a replayed Response is refused", async () => {
      await configure();
      const first = await signIn(entraUser("rex", [MEMBERS]), { signing: "both" });
      expect(first.status).toBe(302);
      const replay = await request(app)
        .post("/api/auth/saml/acs")
        .type("form")
        .send({ SAMLResponse: idp.lastResponse() });
      expect(replay.status).toBe(401);
      expect(replay.body.error.message).toMatch(/InResponseTo/i);
    });

    it.each([
      ["a wrong audience", { wrongAudience: true }, /audience/i],
      ["an expired assertion", { expired: true }, /subject confirmation|expired|not on or after/i],
    ] as const)("%s is refused", async (_label, profile, message) => {
      await configure();
      const acs = await signIn(entraUser("eve", [ADMINS]), { signing: "both", ...profile });
      expect(acs.status).toBe(401);
      expect(acs.body.error.message).toMatch(message);
    });

    it("#1555: a Response signed with the same key whose Issuer names another tenant is refused", async () => {
      await configure();
      const otherTenant = "https://sts.windows.net/0b1ec700-1555-4000-8000-0000000074e2/";
      expect(otherTenant).not.toBe(idp.issuer);
      const acs = await signIn(entraUser("ivy", [ADMINS]), {
        signing: "both",
        issuer: otherTenant,
      });
      expect(acs.status).toBe(401);
      expect(acs.body.error.message).toBe(
        `SAML assertion Issuer "${otherTenant}" does not match the configured IdP issuer ` +
          `"${idp.issuer}"`,
      );
      expect(acs.headers["set-cookie"] ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^metis\.at=/)]),
      );
    });
  },
);
