/**
 * #1376 — `METIS_BOOTSTRAP_ADMINS`: the supported way to get the first admin on
 * an LDAP / OIDC / SAML install.
 *
 * On `main` a production install had none: mock auth is refused, LDAP from env
 * maps everyone to `reader`, and only an admin can set group mappings. The #1312
 * staging run inserted role rows into the database by hand.
 *
 * Against a real migrated SQLite database (the grant runs inside the login's
 * serializable transaction), this proves the grant happens for a listed identity
 * on a database with no admin — and that it can never be replayed once one
 * exists.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: audited }));

const { reconcileTrustedLoginRole } = await import("../src/lib/auth/durable-roles.js");
const {
  bootstrapAdminIdentities,
  isBootstrapAdminCandidate,
  oidcAssertedIdentities,
  samlAssertedIdentities,
} = await import("../src/lib/auth/bootstrap-admins.js");
const { createApp } = await import("../src/app.js");

describe("bootstrapAdminIdentities / isBootstrapAdminCandidate", () => {
  it("parses a comma- or whitespace-separated, case-folded list", () => {
    expect([...bootstrapAdminIdentities(" Alice, bob@Example.com\n carol ,, ")]).toEqual([
      "alice",
      "bob@example.com",
      "carol",
    ]);
    expect(bootstrapAdminIdentities(undefined).size).toBe(0);
    expect(bootstrapAdminIdentities("  ,  ").size).toBe(0);
  });

  it("matches any vouched-for identity, and nothing when the list is empty", () => {
    const listed = bootstrapAdminIdentities("alice,bob@example.com");
    expect(isBootstrapAdminCandidate(["ALICE"], listed)).toBe(true);
    expect(isBootstrapAdminCandidate(["robert", " Bob@Example.com "], listed)).toBe(true);
    expect(isBootstrapAdminCandidate(["mallory", null, undefined], listed)).toBe(false);
    expect(isBootstrapAdminCandidate(["alice"], new Set())).toBe(false);
  });

  it("never matches a look-alike that NFKC would change (#1393 review)", () => {
    const listed = bootstrapAdminIdentities("kate, alice");
    // "\u212Aate".toLowerCase() === "kate": the Kelvin sign.
    expect(isBootstrapAdminCandidate(["\u212Aate"], listed)).toBe(false);
    expect(isBootstrapAdminCandidate(["\uFF41lice"], listed)).toBe(false); // full-width a
    expect(isBootstrapAdminCandidate(["Kate"], listed)).toBe(true);
    // The LIST is NFKC-folded, so an operator who pasted a compatibility form still matches.
    expect(isBootstrapAdminCandidate(["kate"], bootstrapAdminIdentities("\u212Aate"))).toBe(true);
  });

  it("SAML: only identities the assertion states, never a derived local part", () => {
    expect(
      samlAssertedIdentities({
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn": "jdoe@corp.test",
        uid: "jdoe",
        email: "jdoe@corp.test",
        nameID: "jdoe@corp.test",
        cn: "ignored",
      }),
    ).toEqual(["jdoe@corp.test", "jdoe", "jdoe@corp.test", "jdoe@corp.test"]);
    // No upn / uid: METIS derives the username "jdoe" from the e-mail, which is
    // NOT asserted, so it is not offered.
    expect(samlAssertedIdentities({ nameID: "jdoe@other.example" })).toEqual([
      "jdoe@other.example",
    ]);
    expect(samlAssertedIdentities({ uid: 42, email: "" })).toEqual([]);
  });

  it("OIDC: only the email CLAIM, and only when email_verified is true", () => {
    expect(oidcAssertedIdentities({ email: "a@corp.test", email_verified: true })).toEqual([
      "a@corp.test",
    ]);
    expect(oidcAssertedIdentities({ email: "a@corp.test", email_verified: "true" })).toEqual([]);
    expect(oidcAssertedIdentities({ email: "a@corp.test" })).toEqual([]);
    // No email claim: METIS's `email` would fall back to preferred_username/sub.
    expect(
      oidcAssertedIdentities({ preferred_username: "a@corp.test", email_verified: true }),
    ).toEqual([]);
  });
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1376 — first-admin bootstrap (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1376-bootstrap");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(async () => {
      await db.userRole.deleteMany({});
      await db.user.deleteMany({});
      audited.mockClear();
    });
    afterEach(() => vi.unstubAllEnvs());

    async function signIn(username: string, email: string, providerRole: RoleKey = "reader") {
      const user = await db.user.upsert({
        where: { username },
        update: {},
        create: { username, displayName: username, email, status: "active" },
      });
      const role = await reconcileTrustedLoginRole({
        userId: user.id,
        providerRole,
        authRolesInitializedAt: null,
        bootstrapIdentities: [username, email],
      });
      return { id: user.id, role };
    }

    async function adminRows() {
      return db.userRole.findMany({
        where: { role: { key: "admin" } },
        include: { user: { select: { username: true } } },
      });
    }

    it("without the variable, an LDAP login on a fresh install is only a reader (the premise)", async () => {
      expect((await signIn("analyst", "analyst@corp.test")).role).toBe("reader");
      expect(await adminRows()).toEqual([]);
    });

    it("grants a listed username admin as a local role on a database with no admin", async () => {
      vi.stubEnv("METIS_BOOTSTRAP_ADMINS", "analyst");
      const first = await signIn("analyst", "analyst@corp.test");
      expect(first.role).toBe("admin");
      const rows = await adminRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ userId: first.id, source: "local" });
      expect(audited).toHaveBeenCalledWith(
        expect.objectContaining({ action: "user.role.bootstrap_admin", actor: { id: first.id } }),
      );
      // Signing in again keeps the one grant and records nothing new.
      audited.mockClear();
      expect((await signIn("analyst", "analyst@corp.test")).role).toBe("admin");
      expect(await adminRows()).toHaveLength(1);
      expect(audited).not.toHaveBeenCalled();
    });

    it("matches a listed e-mail, case-insensitively", async () => {
      vi.stubEnv("METIS_BOOTSTRAP_ADMINS", "Ops-Lead@Corp.test");
      expect((await signIn("olead", "ops-lead@corp.test")).role).toBe("admin");
    });

    it("cannot be replayed once an admin exists: a second listed identity stays a reader", async () => {
      vi.stubEnv("METIS_BOOTSTRAP_ADMINS", "first, second");
      expect((await signIn("first", "first@corp.test")).role).toBe("admin");
      expect((await signIn("second", "second@corp.test")).role).toBe("reader");
      const rows = await adminRows();
      expect(rows.map((r) => r.user.username)).toEqual(["first"]);
    });

    it("does nothing when an admin already exists from any source (e.g. an LDAP group mapping)", async () => {
      await signIn("group-admin", "ga@corp.test", "admin");
      vi.stubEnv("METIS_BOOTSTRAP_ADMINS", "late");
      expect((await signIn("late", "late@corp.test")).role).toBe("reader");
      expect((await adminRows()).map((r) => r.user.username)).toEqual(["group-admin"]);
    });

    it("never grants an identity that is not listed", async () => {
      vi.stubEnv("METIS_BOOTSTRAP_ADMINS", "someone-else");
      expect((await signIn("analyst", "analyst@corp.test")).role).toBe("reader");
      expect(await adminRows()).toEqual([]);
    });

    it("applies through the real login route", async () => {
      vi.stubEnv("METIS_BOOTSTRAP_ADMINS", "reader");
      const res = await request(createApp())
        .post("/api/auth/login")
        .send({ username: "reader", password: "password" });
      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ username: "reader", role: "admin" });
    });
  },
);
