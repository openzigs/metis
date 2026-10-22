/**
 * #1395 — users were matched across auth providers by username alone.
 *
 * Both `ensureUserRow` functions (password login and SSO) upserted the local
 * user on `username`, so an OIDC user whose `preferred_username` matched an
 * LDAP user's name signed in AS that LDAP account — its roles, workspaces and
 * data. These drive the real routes against a real migrated SQLite database and
 * the in-process OpenID provider (`scripts/lib/mock-oidc-idp.mjs`). LDAP is the
 * only fake: a directory of known accounts behind the real `LDAPAuthProvider`
 * name, since there is no directory server in a unit run.
 */
import { inflateRawSync } from "node:zlib";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import type { Application } from "express";
import type { RoleKey } from "@metis/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const audited = vi.hoisted(() => vi.fn());
const flushed = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: audited,
  getAuditService: () => ({ recordAndFlush: flushed }),
}));

/** The fake directory: username → (password, profile). */
const directory = vi.hoisted(
  () => new Map<string, { password: string; email: string; role: string }>(),
);
vi.mock("../src/lib/auth/ldap-provider.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/auth/ldap-provider.js")>();
  class FakeDirectoryLDAPAuthProvider {
    readonly name = "ldap";
    async authenticate(username: string, password: string) {
      const entry = directory.get(username);
      if (!entry || entry.password !== password) {
        return {
          success: false as const,
          error: "Invalid username or password",
          reason: "invalid_credentials" as const,
        };
      }
      return {
        success: true as const,
        user: {
          username,
          displayName: username,
          email: entry.email,
          role: entry.role as RoleKey,
          groups: [],
        },
      };
    }
  }
  return { ...original, LDAPAuthProvider: FakeDirectoryLDAPAuthProvider };
});

const { createApp } = await import("../src/app.js");
const { __resetAuthProvider } = await import("../src/lib/auth/providers.js");
const { upsertProvider, __resetProviders } = await import("../src/lib/auth/sso-config.js");
const { __clearDiscoveryCache } = await import("../src/lib/auth/oidc-provider.js");
const { __resetSAMLInstances } = await import("../src/lib/auth/saml-provider.js");
const { linkIdentity } = await import("../src/lib/auth/link-identity-cli.js");
const { scimRouter, addScimToken, __resetScimTokens } = await import("../src/routes/scim.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");
const express = (await import("express")).default;
const helpers = await import("../src/lib/auth/__tests__/saml-test-helpers.js");

interface MockUser {
  sub: string;
  preferredUsername: string;
  email: string;
  name: string;
  groups?: string[];
  emailVerified?: boolean;
}
interface MockIdp {
  issuer: string;
  discoveryUrl: string;
  setUser(user: MockUser): void;
  close(): Promise<void>;
}
const mockIdpModule = new URL("../../scripts/lib/mock-oidc-idp.mjs", import.meta.url);
const { startMockOidcIdp } = (await import(mockIdpModule.href)) as {
  startMockOidcIdp(options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    user: MockUser;
  }): Promise<MockIdp>;
};

const UI_ORIGIN = "https://metis.test";
const REDIRECT_URI = `${UI_ORIGIN}/api/auth/oidc/callback`;
const SAML_ISSUER = "https://idp.example.test/saml";

function cookieNames(res: request.Response): string[] {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return (raw ?? []).map((line) => line.slice(0, line.indexOf("=")));
}

function accessCookie(res: request.Response): string {
  const raw = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
  const line = raw.find((l) => l.startsWith("metis.at="));
  if (!line) throw new Error("no metis.at cookie");
  return decodeURIComponent(line.slice(line.indexOf("=") + 1, line.indexOf(";")));
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1395 — a sign-in is matched on its identity, not its username (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let app: Application;
    let idp: MockIdp;
    const previousCors = process.env.CORS_ORIGIN;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1395-identity");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      process.env.CORS_ORIGIN = UI_ORIGIN;
      app = createApp({ corsOrigin: UI_ORIGIN });
      idp = await startMockOidcIdp({
        clientId: "metis-test",
        clientSecret: "metis-test-secret",
        redirectUri: REDIRECT_URI,
        user: { sub: "placeholder", preferredUsername: "x", email: "x@x.test", name: "x" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      process.env.CORS_ORIGIN = previousCors;
      await idp?.close();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.workspaceMember.deleteMany({});
      await db.workspace.deleteMany({});
      await db.userRole.deleteMany({});
      await db.userIdentity.deleteMany({});
      await db.user.deleteMany({});
      directory.clear();
      audited.mockClear();
      vi.stubEnv("AUTH_MODE", "ldap");
      __resetAuthProvider();
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
    });

    afterEach(() => {
      __resetProviders();
      __clearDiscoveryCache();
      __resetSAMLInstances();
      __resetAuthProvider();
      vi.unstubAllEnvs();
    });

    async function ldapLogin(username: string, password = "pw") {
      return request(app)
        .post("/api/auth/login")
        .set("X-METIS-CSRF", "1")
        .send({ username, password });
    }

    async function oidcLogin(user: MockUser) {
      idp.setUser(user);
      const start = await request(app).get("/api/auth/oidc/login");
      expect(start.status).toBe(302);
      const atIdp = await fetch(start.headers.location, { redirect: "manual" });
      const search = new URL(atIdp.headers.get("location")!).search;
      return request(app).get(`/api/auth/oidc/callback${search}`);
    }

    async function samlLogin(nameId: string, uid: string) {
      const key = helpers.getTestSigningKey();
      const acsUrl = `${UI_ORIGIN}/api/auth/saml/acs`;
      const entityId = `${UI_ORIGIN}/api/auth/saml/metadata`;
      upsertProvider({
        mode: "saml",
        name: "Mock SAML",
        enabled: true,
        groupMappings: [],
        defaultRole: "reader",
        saml: {
          entityId,
          acsUrl,
          idpMetadataXml: "",
          idpSsoUrl: "https://idp.example.test/saml/sso",
          idpCerts: [key.certificateBody],
          idpIssuer: SAML_ISSUER,
          signRequests: false,
        },
      });
      const start = await request(app).get("/api/auth/saml/login");
      const samlRequest = new URL(start.headers.location).searchParams.get("SAMLRequest")!;
      const requestId = inflateRawSync(Buffer.from(samlRequest, "base64"))
        .toString("utf8")
        .match(/ID="([^"]+)"/)![1];
      const signed = helpers.signResponse(
        helpers.signAssertion(
          helpers.buildSamlResponseXml({
            audience: entityId,
            recipient: acsUrl,
            issuer: SAML_ISSUER,
            nameId,
            inResponseTo: requestId,
            attributes: { uid },
          }),
          key,
        ),
        key,
      );
      return request(app)
        .post("/api/auth/saml/acs")
        .type("form")
        .send({ SAMLResponse: helpers.toBase64(signed) });
    }

    async function me(token: string) {
      const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      return res.body.data.user as { id: string; username: string; role: string };
    }

    it("an OIDC user named like an LDAP user does NOT get the LDAP account", async () => {
      directory.set("alice", { password: "pw", email: "alice@corp.test", role: "admin" });
      const ldap = await ldapLogin("alice");
      expect(ldap.status).toBe(200);
      const aliceId = ldap.body.data.user.id as string;
      const workspace = await db.workspace.create({ data: { name: "Finance", slug: "finance" } });
      await db.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: aliceId, role: "owner" },
      });

      // Someone at the OIDC IdP picks the username "alice".
      const callback = await oidcLogin({
        sub: "oidc-mallory",
        preferredUsername: "alice",
        email: "mallory@evil.test",
        name: "Mallory",
        groups: ["metis-admins"],
      });

      expect(callback.status).toBe(409);
      expect(callback.body.error.code).toBe("ACCOUNT_LINK_REQUIRED");
      expect(callback.body.error.message).toMatch(/administrator to link/);
      expect(cookieNames(callback)).not.toContain("metis.at");
      expect(cookieNames(callback)).not.toContain("metis.rt");
      // Alice's row, identities and workspaces are untouched; nobody was created.
      const rows = await db.user.findMany({ include: { identities: true } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: aliceId, email: "alice@corp.test", authSource: "ldap" });
      expect(rows[0].identities.map((i) => [i.provider, i.issuer, i.subject])).toEqual([
        ["ldap", "ldap", "name:alice"],
      ]);
      expect(await db.workspaceMember.count({ where: { userId: aliceId } })).toBe(1);
      // The refusal is audited with the exact identity an admin would link.
      expect(audited).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "user.login.failed",
          target: { type: "user", id: aliceId },
          metadata: expect.objectContaining({
            reason: "identity_conflict:other_provider",
            provider: "oidc",
            issuer: idp.issuer,
            subject: "oidc-mallory",
          }),
        }),
      );

      // Alice herself still signs in through LDAP.
      expect((await ldapLogin("alice")).body.data.user.id).toBe(aliceId);
    });

    it("an LDAP user named like an OIDC user does not get the OIDC account either", async () => {
      const first = await oidcLogin({
        sub: "oidc-bob",
        preferredUsername: "bob",
        email: "bob@corp.test",
        name: "Bob",
      });
      expect(first.status).toBe(302);
      directory.set("bob", { password: "pw", email: "bob@ldap.test", role: "reader" });
      const res = await ldapLogin("bob");
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ACCOUNT_LINK_REQUIRED");
      expect(await db.user.count()).toBe(1);
    });

    it("between two SSO providers: a SAML user named like an OIDC user is refused", async () => {
      expect(
        (
          await oidcLogin({
            sub: "oidc-carol",
            preferredUsername: "carol",
            email: "carol@corp.test",
            name: "Carol",
          })
        ).status,
      ).toBe(302);
      const acs = await samlLogin("carol@saml.test", "carol");
      expect(acs.status).toBe(409);
      expect(cookieNames(acs)).not.toContain("metis.at");
    });

    it("the same IdP's identity keeps its account when its username changes", async () => {
      const first = await oidcLogin({
        sub: "oidc-dave",
        preferredUsername: "dave",
        email: "dave@corp.test",
        name: "Dave",
      });
      const before = await me(accessCookie(first));
      const renamed = await oidcLogin({
        sub: "oidc-dave",
        preferredUsername: "david",
        email: "dave@corp.test",
        name: "Dave",
      });
      expect(renamed.status).toBe(302);
      const after = await me(accessCookie(renamed));
      expect(after).toMatchObject({ id: before.id, username: "dave" });
      expect(await db.user.count()).toBe(1);
    });

    it("another subject of the same IdP cannot take a username it already bound", async () => {
      expect(
        (await oidcLogin({ sub: "s-1", preferredUsername: "erin", email: "e@x.test", name: "E" }))
          .status,
      ).toBe(302);
      const other = await oidcLogin({
        sub: "s-2",
        preferredUsername: "erin",
        email: "e2@x.test",
        name: "E2",
      });
      expect(other.status).toBe(409);
      expect(other.body.error.details).toEqual({ reason: "other_subject" });
    });

    it("legacy rows: AUTH_MODE's provider claims an unknown-provenance row; others may not", async () => {
      const legacy = await db.user.create({
        data: { username: "frank", displayName: "Frank", email: "frank@corp.test" },
      });
      // A secondary provider cannot claim a row of unknown provenance…
      const oidc = await oidcLogin({
        sub: "oidc-frank",
        preferredUsername: "frank",
        email: "frank@oidc.test",
        name: "Frank",
      });
      expect(oidc.status).toBe(409);
      // …the deployment's AUTH_MODE provider (LDAP here) can, and binds it.
      directory.set("frank", { password: "pw", email: "frank@corp.test", role: "reader" });
      const ldap = await ldapLogin("frank");
      expect(ldap.status).toBe(200);
      expect(ldap.body.data.user.id).toBe(legacy.id);
      expect(
        await db.userIdentity.findMany({
          where: { userId: legacy.id },
          select: { provider: true, issuer: true, subject: true },
        }),
      ).toEqual([{ provider: "ldap", issuer: "ldap", subject: "name:frank" }]);
      expect((await db.user.findUniqueOrThrow({ where: { id: legacy.id } })).authSource).toBe(
        "ldap",
      );
    });

    it("legacy rows backfilled to an SSO kind are claimed by that kind, not by AUTH_MODE's", async () => {
      const legacy = await db.user.create({
        data: {
          username: "grace",
          displayName: "Grace",
          email: "grace@corp.test",
          authSource: "oidc",
        },
      });
      directory.set("grace", { password: "pw", email: "grace@ldap.test", role: "reader" });
      expect((await ldapLogin("grace")).status).toBe(409);
      const oidc = await oidcLogin({
        sub: "oidc-grace",
        preferredUsername: "grace",
        email: "grace@corp.test",
        name: "Grace",
      });
      expect(oidc.status).toBe(302);
      expect((await me(accessCookie(oidc))).id).toBe(legacy.id);
    });

    it("with no usable AUTH_MODE provider, nothing claims a legacy row", async () => {
      await db.user.create({
        data: { username: "ivan", displayName: "Ivan", email: "ivan@corp.test" },
      });
      // Production refuses the mock fallback that an unset AUTH_MODE resolves to.
      vi.stubEnv("AUTH_MODE", "");
      vi.stubEnv("NODE_ENV", "production");
      __resetAuthProvider();
      const refused = await samlLogin("ivan@saml.test", "ivan");
      const fresh = await samlLogin("judy@saml.test", "judy");
      vi.unstubAllEnvs();
      expect(refused.status).toBe(409);
      // No usable AUTH_MODE kind: refused as another provider's row, not on the e-mail gate.
      expect(refused.body.error.details).toEqual({ reason: "other_provider" });
      expect(fresh.status).toBe(302);
      expect(
        await db.userIdentity.count({ where: { provider: "saml", subject: "ivan@saml.test" } }),
      ).toBe(0);
    });

    describe("an SSO AUTH_MODE claims a legacy row only on a matching VERIFIED e-mail", () => {
      beforeEach(() => {
        vi.stubEnv("AUTH_MODE", "oidc");
        __resetAuthProvider();
      });

      it("the seed's `admin` row does not go to whoever the IdP calls admin", async () => {
        const admin = await db.user.create({
          data: { username: "admin", displayName: "System Admin", email: "admin@metis.local" },
        });
        // Any IdP user may be named "admin"; this one's verified address is not the row's.
        const named = await oidcLogin({
          sub: "oidc-mallory",
          preferredUsername: "admin",
          email: "mallory@evil.test",
          name: "Mallory",
        });
        expect(named.status).toBe(409);
        expect(named.body.error.details).toEqual({ reason: "unverified_email" });
        // The row's own address, but the IdP does not vouch for it.
        const unverified = await oidcLogin({
          sub: "oidc-mallory",
          preferredUsername: "admin",
          email: "ADMIN@metis.local",
          name: "Mallory",
          emailVerified: false,
        });
        expect(unverified.status).toBe(409);
        expect(await db.userIdentity.count({ where: { userId: admin.id } })).toBe(0);
        expect((await db.user.findUniqueOrThrow({ where: { id: admin.id } })).email).toBe(
          "admin@metis.local",
        );
        // Verified and equal (case-folded): the admin's own IdP account claims it.
        const owner = await oidcLogin({
          sub: "oidc-admin",
          preferredUsername: "admin",
          email: "Admin@Metis.Local",
          name: "System Admin",
        });
        expect(owner.status).toBe(302);
        expect((await me(accessCookie(owner))).id).toBe(admin.id);
      });

      it("a verified e-mail NFKC would change never matches (look-alike)", async () => {
        await db.user.create({
          data: { username: "kate", displayName: "Kate", email: "kate@corp.test" },
        });
        const res = await oidcLogin({
          sub: "oidc-kate",
          preferredUsername: "kate",
          email: "Kate@corp.test", // Kelvin sign
          name: "Kate",
        });
        expect(res.status).toBe(409);
      });

      it("SAML asserts no email_verified, so it never claims a legacy row", async () => {
        vi.stubEnv("AUTH_MODE", "saml");
        __resetAuthProvider();
        await db.user.create({
          data: { username: "sam", displayName: "Sam", email: "sam@corp.test" },
        });
        const acs = await samlLogin("sam@corp.test", "sam");
        expect(acs.status).toBe(409);
        expect(acs.body.error.details).toEqual({ reason: "unverified_email" });
      });
    });

    it("LDAP: `Alice` and `alice` are one identity and one account", async () => {
      directory.set("Alice", { password: "pw", email: "alice@corp.test", role: "reader" });
      directory.set("alice", { password: "pw", email: "alice@corp.test", role: "reader" });
      const first = await ldapLogin("Alice");
      const second = await ldapLogin("alice");
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.data.user.id).toBe(first.body.data.user.id);
      expect(await db.user.count()).toBe(1);
      expect(await db.userIdentity.count()).toBe(1);
    });

    it("LDAP: a legacy row is found whatever case the user types first (round-3 panel)", async () => {
      const legacy = await db.user.create({
        data: { username: "jsmith", displayName: "J", email: "jsmith@corp.test" },
      });
      directory.set("JSmith", { password: "pw", email: "jsmith@corp.test", role: "reader" });
      const res = await ldapLogin("JSmith");
      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ id: legacy.id, username: "jsmith" });
      expect(await db.user.count()).toBe(1);

      // Legacy duplicates differing only in case are ambiguous: refused, not guessed.
      await db.user.create({ data: { username: "Dup", displayName: "D", email: "d1@x.test" } });
      await db.user.create({ data: { username: "dup", displayName: "D", email: "d2@x.test" } });
      directory.set("DUP", { password: "pw", email: "d@x.test", role: "reader" });
      const dup = await ldapLogin("DUP");
      expect(dup.status).toBe(409);
      expect(
        await db.userIdentity.count({ where: { provider: "ldap", subject: "name:dup" } }),
      ).toBe(0);
    });

    it("a disabled or deleted account is refused and never written on the login path", async () => {
      directory.set("kim", { password: "pw", email: "kim@corp.test", role: "reader" });
      const kimId = (await ldapLogin("kim")).body.data.user.id as string;
      const before = await db.user.findUniqueOrThrow({ where: { id: kimId } });
      await db.user.update({ where: { id: kimId }, data: { status: "disabled" } });
      directory.set("kim", { password: "pw", email: "kim-new@corp.test", role: "admin" });
      const disabled = await ldapLogin("kim");
      expect(disabled.status).toBe(403);
      expect(disabled.body.error.code).toBe("ACCOUNT_DISABLED");
      const after = await db.user.findUniqueOrThrow({ where: { id: kimId } });
      expect(after.email).toBe("kim@corp.test");
      expect(after.lastLoginAt).toEqual(before.lastLoginAt);

      // A soft-deleted legacy row is not claimed either.
      const gone = await db.user.create({
        data: {
          username: "lee",
          displayName: "Lee",
          email: "lee@corp.test",
          deletedAt: new Date(),
        },
      });
      directory.set("lee", { password: "pw", email: "lee@corp.test", role: "reader" });
      expect((await ldapLogin("lee")).status).toBe(403);
      expect(await db.userIdentity.count({ where: { userId: gone.id } })).toBe(0);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: gone.id } })).deletedAt,
      ).not.toBeNull();
    });

    it("SCIM reviving a deleted username drops the old person's identities and provider", async () => {
      const old = await oidcLogin({
        sub: "oidc-old-pat",
        preferredUsername: "pat",
        email: "pat@corp.test",
        name: "Old Pat",
      });
      const patId = (await me(accessCookie(old))).id;
      await db.user.update({ where: { id: patId }, data: { deletedAt: new Date() } });

      __resetScimTokens();
      addScimToken("scim-1395");
      const scim = express();
      scim.use(express.json());
      scim.use("/scim/v2", scimRouter());
      scim.use(errorHandler);
      const created = await request(scim)
        .post("/scim/v2/Users")
        .set("Authorization", "Bearer scim-1395")
        .send({ userName: "pat", emails: [{ value: "new.pat@corp.test" }] });
      expect(created.status).toBe(201);
      const revived = await db.user.findUniqueOrThrow({
        where: { id: patId },
        include: { identities: true },
      });
      expect(revived).toMatchObject({ deletedAt: null, authSource: "scim", identities: [] });

      // The deleted person's IdP account no longer signs in as the new pat.
      const again = await oidcLogin({
        sub: "oidc-old-pat",
        preferredUsername: "pat",
        email: "pat@corp.test",
        name: "Old Pat",
      });
      expect(again.status).toBe(409);
      __resetScimTokens();
    });

    it("SCIM-provisioned users sign in through an SSO AUTH_MODE with no e-mail gate (round-2 panel)", async () => {
      __resetScimTokens();
      addScimToken("scim-1395");
      const scim = express();
      scim.use(express.json());
      scim.use("/scim/v2", scimRouter());
      scim.use(errorHandler);
      const provision = (userName: string) =>
        request(scim)
          .post("/scim/v2/Users")
          .set("Authorization", "Bearer scim-1395")
          .send({ userName, emails: [{ value: `${userName}@corp.test` }] });
      expect((await provision("quinn")).status).toBe(201);
      expect((await provision("rosa")).status).toBe(201);
      const quinn = await db.user.findUniqueOrThrow({ where: { username: "quinn" } });
      expect(quinn.authSource).toBe("scim");

      // SAML asserts no email_verified — the IdP that provisioned quinn signs quinn in.
      vi.stubEnv("AUTH_MODE", "saml");
      __resetAuthProvider();
      const acs = await samlLogin("quinn@corp.test", "quinn");
      expect(acs.status).toBe(302);
      expect((await me(accessCookie(acs))).id).toBe(quinn.id);

      // OIDC without email_verified likewise claims the SCIM row.
      vi.stubEnv("AUTH_MODE", "oidc");
      __resetAuthProvider();
      const rosa = await oidcLogin({
        sub: "oidc-rosa",
        preferredUsername: "rosa",
        email: "rosa@corp.test",
        name: "Rosa",
        emailVerified: false,
      });
      expect(rosa.status).toBe(302);
      expect(
        await db.user.findUniqueOrThrow({
          where: { username: "rosa" },
          select: { authSource: true },
        }),
      ).toEqual({ authSource: "oidc" });
      __resetScimTokens();
    });

    it("a link made before the account's own provider signs in does not lock that provider out (round-3 panel)", async () => {
      const legacy = await db.user.create({
        data: { username: "olga", displayName: "Olga", email: "olga@corp.test" },
      });
      const user = { sub: "oidc-olga", preferredUsername: "olga", email: "x@x.test", name: "O" };
      expect((await oidcLogin(user)).status).toBe(409);
      await linkIdentity({
        operator: "ops",
        username: "olga",
        identity: { provider: "oidc", issuer: idp.issuer, subject: "oidc-olga" },
      });
      // AUTH_MODE is LDAP: the directory still claims its legacy row…
      directory.set("olga", { password: "pw", email: "olga@corp.test", role: "reader" });
      const ldap = await ldapLogin("olga");
      expect(ldap.status).toBe(200);
      expect(ldap.body.data.user.id).toBe(legacy.id);
      // …and the linked identity keeps working. Both are bound now.
      const oidc = await oidcLogin(user);
      expect(oidc.status).toBe(302);
      expect((await me(accessCookie(oidc))).id).toBe(legacy.id);
      expect(
        (await db.userIdentity.findMany({ where: { userId: legacy.id } }))
          .map((i) => i.provider)
          .sort(),
      ).toEqual(["ldap", "oidc"]);
      // A third provider is still refused: the row is LDAP's now.
      const acs = await samlLogin("olga@saml.test", "olga");
      expect(acs.status).toBe(409);
    });

    it("an administrator's explicit link lets the second identity in", async () => {
      directory.set("heidi", { password: "pw", email: "heidi@corp.test", role: "coordinator" });
      const ldap = await ldapLogin("heidi");
      const heidiId = ldap.body.data.user.id as string;
      const user = {
        sub: "oidc-heidi",
        preferredUsername: "heidi",
        email: "heidi@corp.test",
        name: "H",
      };
      expect((await oidcLogin(user)).status).toBe(409);

      await expect(
        linkIdentity({
          operator: "ops",
          username: "heidi",
          identity: { provider: "oidc", issuer: idp.issuer, subject: "oidc-heidi" },
        }),
      ).resolves.toEqual({ userId: heidiId, created: true });
      expect(flushed).toHaveBeenCalledWith(
        expect.objectContaining({ action: "user.identity.linked", targetId: heidiId }),
      );

      const linked = await oidcLogin(user);
      expect(linked.status).toBe(302);
      expect((await me(accessCookie(linked))).id).toBe(heidiId);
    });
  },
);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1395 — the migration records the provider existing users came from (real SQLite)",
  () => {
    const MIGRATION = "20261025001395_issue1395_user_identities";
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(() => {
      sqlite = createMigratedSqlite("1395-backfill", { stopBefore: MIGRATION });
      const user = (id: string) =>
        sqlite.exec(
          `INSERT INTO "users" ("id","username","displayName","email","updatedAt") VALUES (?,?,?,?,CURRENT_TIMESTAMP)`,
          [id, id, id, `${id}@corp.test`],
        );
      const login = (id: string, actorId: string, metadata: Record<string, unknown> | null) =>
        sqlite.exec(
          `INSERT INTO "audit_logs" ("id","actorId","action","targetType","targetId","metadata") VALUES (?,?,'user.login','user',?,?)`,
          [id, actorId, actorId, metadata ? JSON.stringify(metadata) : null],
        );
      for (const id of ["oidc_only", "saml_only", "mixed", "password", "never", "oidc_a"]) user(id);
      // SCIM-provisioned: one never signed in, one whose SAML logins place it first.
      for (const id of ["scim_new", "scim_saml"]) {
        user(id);
        sqlite.exec(`UPDATE "users" SET "authRoleAuthority" = 'scim' WHERE "id" = ?`, [id]);
      }
      login("l7", "scim_saml", { username: "scim_saml", role: "reader", mode: "saml" });
      login("l1", "oidc_only", { username: "oidc_only", role: "reader", mode: "oidc" });
      login("l2", "oidc_only", { username: "oidc_only", role: "reader", mode: "oidc" });
      login("l3", "saml_only", { username: "saml_only", role: "reader", mode: "saml" });
      // The #1395 defect merged these: one row signed in through two providers.
      login("l4", "mixed", { username: "mixed", role: "reader", mode: "oidc" });
      login("l5", "mixed", { username: "mixed", role: "admin" });
      login("l6", "password", { username: "password", role: "reader" });
      // A failed login that mentions a mode does not count.
      sqlite.exec(
        `INSERT INTO "audit_logs" ("id","actorId","action","targetType","targetId","metadata") VALUES ('x1','oidc_a','user.login.failed','user','oidc_a','{"mode":"oidc"}')`,
      );
      sqlite.apply(MIGRATION);
      sqlite.applyRemaining();
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("backfills a single-mode SSO history, then SCIM rows, and leaves everything else legacy (null)", async () => {
      const rows = await db.user.findMany({
        select: { username: true, authSource: true },
        orderBy: { username: "asc" },
      });
      expect(Object.fromEntries(rows.map((r) => [r.username, r.authSource]))).toEqual({
        mixed: null,
        never: null,
        oidc_a: null,
        oidc_only: "oidc",
        password: null,
        saml_only: "saml",
        scim_new: "scim",
        scim_saml: "saml",
      });
      expect(await db.userIdentity.count()).toBe(0);
    });
  },
);
