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
const helpers = await import("../src/lib/auth/__tests__/saml-test-helpers.js");

interface MockUser {
  sub: string;
  preferredUsername: string;
  email: string;
  name: string;
  groups?: string[];
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
        ["ldap", "ldap", "alice"],
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
      ).toEqual([{ provider: "ldap", issuer: "ldap", subject: "frank" }]);
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
      expect(fresh.status).toBe(302);
      expect(
        await db.userIdentity.count({ where: { provider: "saml", subject: "ivan@saml.test" } }),
      ).toBe(0);
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

    it("backfills a single-mode SSO history and leaves everything else legacy (null)", async () => {
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
      });
      expect(await db.userIdentity.count()).toBe(0);
    });
  },
);
