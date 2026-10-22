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
  it("directory providers key on the account name, issuer = the kind", () => {
    expect(directoryIdentity("ldap", "alice")).toEqual({
      provider: "ldap",
      issuer: "ldap",
      subject: "alice",
    });
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
    ).toEqual({ provider: "saml", issuer: "urn:cfg", subject: "alice" });
    expect(samlIdentity({}, "urn:cfg", "alice")?.subject).toBe("alice");
    expect(samlIdentity({ nameID: "n" }, "", "alice")).toBeNull();
    expect(samlIdentity({ issuer: "urn:idp" }, "", "")).toBeNull();
  });

  it("knows the provider kinds", () => {
    expect(isLoginProviderKind("oidc")).toBe(true);
    expect(isLoginProviderKind("scim")).toBe(false);
  });
});

describe("usernameClaimVerdict", () => {
  const ldapRow = { authSource: "ldap", identities: [{ provider: "ldap", issuer: "ldap" }] };

  it("refuses a username bound to another provider", () => {
    expect(usernameClaimVerdict(ldapRow, OIDC, "ldap")).toBe("other_provider");
  });

  it("refuses another subject of the same provider and issuer", () => {
    const row = { authSource: "oidc", identities: [{ provider: "oidc", issuer: OIDC.issuer }] };
    expect(usernameClaimVerdict(row, OIDC, "oidc")).toBe("other_subject");
    // Another issuer of the same kind is another provider.
    const other = { authSource: "oidc", identities: [{ provider: "oidc", issuer: "https://b" }] };
    expect(usernameClaimVerdict(other, OIDC, "oidc")).toBe("other_provider");
  });

  it("an unbound row is claimed only by its own kind, or by AUTH_MODE's when unknown", () => {
    expect(usernameClaimVerdict({ authSource: "oidc", identities: [] }, OIDC, "ldap")).toBe(
      "claim",
    );
    expect(usernameClaimVerdict({ authSource: "saml", identities: [] }, OIDC, "oidc")).toBe(
      "other_provider",
    );
    expect(usernameClaimVerdict({ authSource: null, identities: [] }, OIDC, "oidc")).toBe("claim");
    expect(usernameClaimVerdict({ authSource: null, identities: [] }, OIDC, "ldap")).toBe(
      "other_provider",
    );
    expect(usernameClaimVerdict({ authSource: null, identities: [] }, OIDC, null)).toBe(
      "other_provider",
    );
  });
});

describe("resolveLoginUser — races", () => {
  it("a concurrent first sign-in that created the user is judged again, and found", async () => {
    db.userIdentity.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "i1",
      userId: "u1",
    });
    db.user.findUnique.mockResolvedValueOnce(null);
    db.user.create.mockRejectedValueOnce(unique());
    db.userIdentity.update.mockResolvedValue({});
    db.user.update.mockResolvedValue(ROW);

    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).resolves.toEqual(ROW);
    expect(db.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "u1" } }));
  });

  it("a claim that lost its row to another provider is refused on the second look", async () => {
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique
      .mockResolvedValueOnce({ id: "u1", authSource: null, identities: [] })
      .mockResolvedValueOnce({
        id: "u1",
        authSource: "ldap",
        identities: [{ provider: "ldap", issuer: "ldap" }],
      });
    db.user.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACCOUNT_LINK_REQUIRED" });
    expect(db.userIdentity.create).not.toHaveBeenCalled();
  });

  it("a claim takes only the row it judged — unbound and of the judged kind — in one serializable transaction", async () => {
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue({ id: "u1", authSource: null, identities: [] });
    db.user.updateMany.mockResolvedValue({ count: 1 });
    db.userIdentity.create.mockResolvedValue({});
    db.user.findUniqueOrThrow.mockResolvedValue(ROW);

    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).resolves.toEqual(ROW);
    expect(db.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u1", authSource: null, identities: { none: {} } },
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

  it("a serialization failure (P2034) is judged again like a unique violation", async () => {
    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique
      .mockResolvedValueOnce({ id: "u1", authSource: "oidc", identities: [] })
      .mockResolvedValueOnce({
        id: "u1",
        authSource: "oidc",
        identities: [{ provider: "oidc", issuer: OIDC.issuer }],
      });
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

    db.userIdentity.findUnique.mockResolvedValue(null);
    db.user.findUnique.mockResolvedValue(null);
    db.user.create.mockRejectedValueOnce(unique()).mockRejectedValueOnce(new Error("db down 2"));
    await expect(
      resolveLoginUser({ identity: OIDC, profile: PROFILE, primaryKind: "oidc" }),
    ).rejects.toThrow("db down 2");
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
