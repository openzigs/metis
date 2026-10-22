/**
 * #1395 — the pure identity policy and the race branches of `resolveLoginUser`
 * that a real database cannot be made to hit on demand. The end-to-end proof
 * against real routes and SQLite is `tests/login-identity-1395.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  $transaction: vi.fn(),
  userIdentity: { findUnique: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn() },
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
const audited = vi.hoisted(() => vi.fn());
const flushed = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../audit/audit-service.js", () => ({
  audit: audited,
  getAuditService: () => ({ recordAndFlush: flushed }),
}));

const {
  directoryIdentity,
  isLoginProviderKind,
  oidcIdentity,
  resolveLoginUser,
  samlIdentity,
  usernameClaimVerdict,
} = await import("./login-identity.js");
const { ldapSubject } = await import("./ldap-provider.js");
const { runLinkIdentityCli } = await import("./link-identity-cli.js");

const OIDC = { provider: "oidc", issuer: "https://idp.test", subject: "s-1" } as const;
const PROFILE = { username: "alice", displayName: "Alice", email: "a@corp.test" };
const ROW = { id: "u1", username: "alice", authRolesInitializedAt: null };
const unique = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

beforeEach(() => {
  vi.resetAllMocks();
  flushed.mockResolvedValue(undefined);
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
});

describe("identity keys", () => {
  it("directory providers key on the directory's id, else the folded account name", () => {
    expect(directoryIdentity("ldap", { username: "Alice" })).toEqual({
      provider: "ldap",
      issuer: "ldap",
      subject: "name:alice",
    });
    expect(directoryIdentity("mock", { username: " ALICE " }).subject).toBe("name:alice");
    expect(directoryIdentity("ldap", { username: "Alice", subject: "entryUUID:abc" }).subject).toBe(
      "entryUUID:abc",
    );
    expect(directoryIdentity("ldap", { username: "bob", subject: " " }).subject).toBe("name:bob");
    // A look-alike NFKC would fold to `kate` keeps an identity of its own.
    expect(directoryIdentity("ldap", { username: "Kate" }).subject).toBe("name-exact:Kate");
    expect(directoryIdentity("ldap", { username: "Kate" }).subject).toBe("name:kate");
  });

  it("LDAP subjects: entryUUID, else a 16-byte objectGUID, else the directory's own name", () => {
    const guid = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    expect(ldapSubject({ entryUUID: ["ABC-1"], objectGUID: guid }, "x")).toBe("entryUUID:abc-1");
    expect(ldapSubject({ objectGUID: [guid] }, "x")).toBe(`objectGUID:${guid.toString("hex")}`);
    // A GUID mangled to a string, or the wrong length, is not an id.
    expect(ldapSubject({ objectGUID: "garbled", uid: "Alice" }, "x")).toBe("name:alice");
    expect(ldapSubject({ objectGUID: Buffer.alloc(4), sAMAccountName: "BOB" }, "x")).toBe(
      "name:bob",
    );
    expect(ldapSubject({}, "Typed")).toBe("name:typed");
  });

  it("OIDC keys on iss + sub, never preferred_username", () => {
    expect(oidcIdentity({ iss: "https://idp.test", sub: "s-1", preferred_username: "x" })).toEqual(
      OIDC,
    );
    expect(oidcIdentity({ iss: "https://idp.test", preferred_username: "alice" })).toBeNull();
    expect(oidcIdentity({ iss: " ", sub: "s-1" })).toBeNull();
    expect(oidcIdentity({ iss: "https://idp.test", sub: 42 })).toBeNull();
  });

  it("SAML keys on the assertion issuer + NameID, the username for a transient NameID", () => {
    expect(samlIdentity({ issuer: "urn:idp", nameID: "n-1" }, "urn:cfg", "alice")).toEqual({
      provider: "saml",
      issuer: "urn:idp",
      subject: "n-1",
    });
    expect(
      samlIdentity(
        {
          nameID: "_t1",
          nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
        },
        "urn:cfg",
        "alice",
      ),
    ).toEqual({
      provider: "saml",
      issuer: "urn:cfg",
      subject: "urn:metis:saml:transient-username:alice",
    });
    expect(samlIdentity({}, "urn:cfg", "alice")?.subject).toBe(
      "urn:metis:saml:transient-username:alice",
    );
    // The fallback cannot collide with a persistent NameID equal to the username.
    expect(samlIdentity({ nameID: "alice" }, "urn:cfg", "alice")?.subject).toBe("alice");
    expect(samlIdentity({ nameID: "n" }, "", "alice")).toBeNull();
    expect(samlIdentity({ issuer: "urn:idp" }, "", "")).toBeNull();
  });

  it("knows the provider kinds", () => {
    expect(isLoginProviderKind("oidc")).toBe(true);
    expect(isLoginProviderKind("scim")).toBe(false);
  });
});

describe("usernameClaimVerdict", () => {
  const email = "a@corp.test";
  const ldapRow = {
    authSource: "ldap",
    email,
    identities: [{ provider: "ldap", issuer: "ldap" }],
  };

  it("refuses a username bound to another provider", () => {
    expect(usernameClaimVerdict(ldapRow, OIDC, "ldap")).toBe("other_provider");
  });

  it("refuses another subject of the same provider and issuer", () => {
    const row = {
      authSource: "oidc",
      email,
      identities: [{ provider: "oidc", issuer: OIDC.issuer }],
    };
    expect(usernameClaimVerdict(row, OIDC, "oidc")).toBe("other_subject");
    // Another issuer of the same kind is another provider.
    const other = { ...row, identities: [{ provider: "oidc", issuer: "https://b" }] };
    expect(usernameClaimVerdict(other, OIDC, "oidc")).toBe("other_provider");
  });

  it("an unbound row is claimed only by its own kind, or by AUTH_MODE's when unknown", () => {
    const unbound = (authSource: string | null) => ({ authSource, email, identities: [] });
    expect(usernameClaimVerdict(unbound("oidc"), OIDC, "ldap")).toBe("claim");
    expect(usernameClaimVerdict(unbound("saml"), OIDC, "oidc")).toBe("other_provider");
    expect(usernameClaimVerdict(unbound(null), OIDC, "ldap", email)).toBe("other_provider");
    expect(usernameClaimVerdict(unbound(null), OIDC, null, email)).toBe("other_provider");
    // Operator-linked identities on a NULL / scim row do not lock out its own provider…
    const linkedOidc = [{ provider: "oidc", issuer: OIDC.issuer }];
    const ldapId = { provider: "ldap", issuer: "ldap", subject: "name:a" } as const;
    expect(
      usernameClaimVerdict({ authSource: null, email, identities: linkedOidc }, ldapId, "ldap"),
    ).toBe("claim");
    expect(
      usernameClaimVerdict({ authSource: "scim", email, identities: linkedOidc }, ldapId, "ldap"),
    ).toBe("claim");
    // …but a row a sign-in claimed (kind recorded) is that provider's alone.
    expect(
      usernameClaimVerdict({ authSource: "oidc", email, identities: linkedOidc }, ldapId, "ldap"),
    ).toBe("other_provider");
    // A SCIM row is the IdP's: AUTH_MODE's provider claims it, with no e-mail gate.
    const saml = { provider: "saml", issuer: "urn:idp", subject: "n" } as const;
    expect(usernameClaimVerdict(unbound("scim"), saml, "saml", null)).toBe("claim");
    expect(usernameClaimVerdict(unbound("scim"), OIDC, "oidc", null)).toBe("claim");
    expect(usernameClaimVerdict(unbound("scim"), OIDC, "ldap", email)).toBe("other_provider");
    expect(usernameClaimVerdict(unbound("scim"), OIDC, null, email)).toBe("other_provider");
    // A directory AUTH_MODE claims its legacy rows by name, as before.
    const ldap = { provider: "ldap", issuer: "ldap", subject: "name:a" } as const;
    expect(usernameClaimVerdict(unbound(null), ldap, "ldap")).toBe("claim");
  });

  it("an SSO AUTH_MODE claims a legacy row only on a verified e-mail equal to the row's", () => {
    const unbound = { authSource: null, email: "Admin@Metis.local", identities: [] };
    expect(usernameClaimVerdict(unbound, OIDC, "oidc", "admin@metis.LOCAL")).toBe("claim");
    expect(usernameClaimVerdict(unbound, OIDC, "oidc", null)).toBe("unverified_email");
    expect(usernameClaimVerdict(unbound, OIDC, "oidc", "")).toBe("unverified_email");
    expect(usernameClaimVerdict(unbound, OIDC, "oidc", "evil@metis.local")).toBe(
      "unverified_email",
    );
    // NFKC would fold the Kelvin sign to "k": a look-alike never matches.
    const kate = { ...unbound, email: "kate@corp.test" };
    expect(usernameClaimVerdict(kate, OIDC, "oidc", "Kate@corp.test")).toBe("unverified_email");
    const saml = { provider: "saml", issuer: "urn:idp", subject: "n" } as const;
    expect(usernameClaimVerdict(unbound, saml, "saml", null)).toBe("unverified_email");
  });
});

describe("resolveLoginUser — races and account state", () => {
  const ACTIVE_USER = { status: "active", deletedAt: null };
  const legacy = (over: Record<string, unknown> = {}) => ({
    id: "u1",
    email: PROFILE.email,
    status: "active",
    deletedAt: null,
    authSource: "oidc",
    identities: [],
    ...over,
  });

  it("a concurrent first sign-in that created the user is judged again, and found", async () => {
    db.userIdentity.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "i1",
      userId: "u1",
      user: ACTIVE_USER,
    });
    db.user.findUnique.mockResolvedValueOnce(null);
    db.user.create.mockRejectedValueOnce(unique());
    db.userIdentity.update.mockResolvedValue({});
    db.user.update.mockResolvedValue(ROW);

    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).resolves.toEqual(ROW);
    // The write is conditional on the account still being active.
    expect(db.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "u1", deletedAt: null, status: "active" } }),
    );
  });

  it.each([
    ["disabled", { status: "disabled", deletedAt: null }],
    ["deleted", { status: "active", deletedAt: new Date() }],
  ])("a bound identity of a %s account is refused 403, with no writes", async (_, user) => {
    db.userIdentity.findUnique.mockResolvedValue({ id: "i1", userId: "u1", user });
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCOUNT_DISABLED" });
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.userIdentity.update).not.toHaveBeenCalled();
    expect(audited).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ reason: "account_inactive" }),
      }),
    );
  });

  it("an account disabled between the read and the write is refused 403 (P2025)", async () => {
    db.userIdentity.findUnique.mockResolvedValue({ id: "i1", userId: "u1", user: ACTIVE_USER });
    db.user.update.mockRejectedValue(Object.assign(new Error("not found"), { code: "P2025" }));
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toMatchObject({ statusCode: 403, code: "ACCOUNT_DISABLED" });
    expect(db.userIdentity.update).not.toHaveBeenCalled();
  });

  it("an unbound disabled or deleted row is never claimed", async () => {
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValueOnce(legacy({ status: "disabled" }));
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    db.user.findUnique.mockResolvedValueOnce(legacy({ deletedAt: new Date() }));
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("a claim that lost its row to another provider is refused on the second look", async () => {
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique
      .mockResolvedValueOnce(legacy())
      .mockResolvedValueOnce(
        legacy({ authSource: "ldap", identities: [{ provider: "ldap", issuer: "ldap" }] }),
      );
    db.user.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "ldap" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACCOUNT_LINK_REQUIRED" });
    expect(db.userIdentity.create).not.toHaveBeenCalled();
  });

  it("a claim takes only the row it judged — active, unbound, of the judged kind — in one serializable transaction", async () => {
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(legacy({ authSource: null }));
    db.user.updateMany.mockResolvedValue({ count: 1 });
    db.userIdentity.create.mockResolvedValue({});
    db.user.findUniqueOrThrow.mockResolvedValue(ROW);

    await expect(
      resolveLoginUser({
        identity: OIDC,
        profile: { ...PROFILE, verifiedEmail: PROFILE.email },
        primaryKind: "oidc",
      }),
    ).resolves.toEqual(ROW);
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "u1",
          authSource: null,
          deletedAt: null,
          status: "active",
          identities: { none: {} },
        },
        data: expect.objectContaining({ authSource: "oidc" }),
      }),
    );
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(db.userIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ ...OIDC, userId: "u1" }),
    });
  });

  it("claiming a row that carries only operator-linked identities requires none of this provider", async () => {
    const ldapId = { provider: "ldap", issuer: "ldap", subject: "name:alice" } as const;
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(
      legacy({ authSource: null, identities: [{ provider: "oidc", issuer: OIDC.issuer }] }),
    );
    db.user.updateMany.mockResolvedValue({ count: 1 });
    db.userIdentity.create.mockResolvedValue({});
    db.user.findUniqueOrThrow.mockResolvedValue(ROW);
    await expect(
      resolveLoginUser({ identity: ldapId, profile: PROFILE, primaryKind: "ldap" }),
    ).resolves.toEqual(ROW);
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "u1",
          authSource: null,
          deletedAt: null,
          status: "active",
          identities: { none: { provider: "ldap", issuer: "ldap" } },
        },
      }),
    );
  });

  it("an SSO claim of a legacy row with no verified e-mail is refused before any write", async () => {
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(legacy({ authSource: null }));
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toMatchObject({ statusCode: 409, details: { reason: "unverified_email" } });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("a serialization failure (P2034) is judged again like a unique violation", async () => {
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique
      .mockResolvedValueOnce(legacy())
      .mockResolvedValueOnce(legacy({ identities: [{ provider: "oidc", issuer: OIDC.issuer }] }));
    db.$transaction.mockRejectedValueOnce(Object.assign(new Error("40001"), { code: "P2034" }));
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "ldap" }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_LINK_REQUIRED",
      details: { reason: "other_subject" },
    });
  });

  it("a unique conflict that persists (the e-mail is another user's) is a 409, audited", async () => {
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockRejectedValue(unique());

    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "ACCOUNT_LINK_REQUIRED",
      details: { reason: "unique_conflict" },
    });
    expect(audited).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user.login.failed",
        target: { type: "user", id: "alice" },
        metadata: expect.objectContaining({ reason: "identity_conflict:unique_conflict" }),
      }),
    );
  });

  it("any other database error propagates untouched, on either attempt", async () => {
    db.userIdentity.findUnique.mockRejectedValueOnce(new Error("db down"));
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toThrow("db down");

    db.userIdentity.findUnique.mockResolvedValue({ id: "i1", userId: "u1", user: ACTIVE_USER });
    db.user.update.mockRejectedValueOnce(new Error("db down 2"));
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toThrow("db down 2");

    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockRejectedValueOnce(unique()).mockRejectedValueOnce(new Error("db down 3"));
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toThrow("db down 3");
  });
});

describe("link-identity CLI", () => {
  const LINK = [
    "link",
    "--operator",
    "ops",
    "--username",
    "alice",
    "--provider",
    "oidc",
    "--issuer",
    OIDC.issuer,
    "--subject",
    OIDC.subject,
  ];

  it("links an unbound identity and audits who did it", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", username: "alice", deletedAt: null });
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.userIdentity.create.mockResolvedValue({});
    await expect(runLinkIdentityCli(LINK)).resolves.toEqual({ userId: "u1", created: true });
    expect(db.userIdentity.create).toHaveBeenCalledWith({
      data: { ...OIDC, userId: "u1", linkedBy: "ops" },
    });
    expect(flushed).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "user.identity.linked",
        targetId: "u1",
        metadata: expect.objectContaining({ operator: "ops", subject: OIDC.subject }),
      }),
    );
  });

  it("is a no-op for an identity already bound to the same user", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", username: "alice", deletedAt: null });
    db.userIdentity.findUnique.mockResolvedValue({ userId: "u1" });
    await expect(runLinkIdentityCli(LINK)).resolves.toEqual({ userId: "u1", created: false });
    expect(db.userIdentity.create).not.toHaveBeenCalled();
  });

  it("refuses an identity bound to someone else, and an absent or deleted user", async () => {
    db.user.findUnique.mockResolvedValueOnce({ id: "u1", username: "alice", deletedAt: null });
    db.userIdentity.findUnique.mockResolvedValueOnce({ userId: "u2" });
    await expect(runLinkIdentityCli(LINK)).rejects.toThrow(/another user/);

    db.user.findUnique.mockResolvedValueOnce(null);
    await expect(runLinkIdentityCli(LINK)).rejects.toThrow(/No active user/);
    db.user.findUnique.mockResolvedValueOnce({ id: "u1", deletedAt: new Date() });
    await expect(runLinkIdentityCli(LINK)).rejects.toThrow(/No active user/);
  });

  it("lists a user's identities", async () => {
    db.user.findUnique.mockResolvedValue({ id: "u1", username: "alice", deletedAt: null });
    db.userIdentity.findMany.mockResolvedValue([{ ...OIDC, linkedBy: null }]);
    await expect(runLinkIdentityCli(["list", "--username", "alice"])).resolves.toEqual([
      { ...OIDC, linkedBy: null },
    ]);
  });

  it("rejects incomplete or unknown arguments", async () => {
    await expect(runLinkIdentityCli([])).rejects.toThrow(/Usage/);
    await expect(runLinkIdentityCli(["unlink", "--username", "a"])).rejects.toThrow(/Usage/);
    await expect(runLinkIdentityCli(["link", "--username", "a"])).rejects.toThrow(/Usage/);
    const scim = LINK.map((v) => (v === "oidc" ? "scim" : v));
    await expect(runLinkIdentityCli(scim)).rejects.toThrow(/Unknown provider "scim"/);
    expect(db.userIdentity.create).not.toHaveBeenCalled();
  });
});
