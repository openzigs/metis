/**
 * #2344 — a verified access token maps to exactly one active METIS user,
 * through the OIDC identity METIS bound at sign-in, or to none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("../../../lib/prisma.js", () => ({
  prisma: { userIdentity: { findUnique: m.findUnique } },
}));

const { mapAccessTokenToUser, mappedUserVerifier, REMOTE_TOKEN_ID } = await import("./identity.js");

const token = {
  issuer: "https://idp.example.com",
  subject: "sub-1",
  scopes: ["mcp:read"],
  expiresAt: 1,
};

describe("mapAccessTokenToUser", () => {
  beforeEach(() => m.findUnique.mockReset());

  it("looks the subject up by (oidc, issuer, subject) and returns its active user", async () => {
    m.findUnique.mockResolvedValue({ userId: "u1", user: { status: "active", deletedAt: null } });
    await expect(mapAccessTokenToUser(token)).resolves.toEqual({ ok: true, userId: "u1" });
    expect(m.findUnique).toHaveBeenCalledWith({
      where: {
        provider_issuer_subject: {
          provider: "oidc",
          issuer: "https://idp.example.com",
          subject: "sub-1",
        },
      },
      select: { userId: true, user: { select: { status: true, deletedAt: true } } },
    });
  });

  it("refuses a subject no METIS user signed in with", async () => {
    m.findUnique.mockResolvedValue(null);
    await expect(mapAccessTokenToUser(token)).resolves.toEqual({ ok: false, reason: "unmapped" });
  });

  it("refuses a disabled or deleted user", async () => {
    m.findUnique.mockResolvedValue({ userId: "u1", user: { status: "disabled", deletedAt: null } });
    await expect(mapAccessTokenToUser(token)).resolves.toEqual({ ok: false, reason: "inactive" });
    m.findUnique.mockResolvedValue({
      userId: "u1",
      user: { status: "active", deletedAt: new Date() },
    });
    await expect(mapAccessTokenToUser(token)).resolves.toEqual({ ok: false, reason: "inactive" });
  });
});

describe("mappedUserVerifier", () => {
  it("returns the mapped user with the read scope only, whatever it is handed", async () => {
    const verify = mappedUserVerifier("u1");
    const expected = { tokenId: REMOTE_TOKEN_ID, userId: "u1", scopes: ["acp:read"] };
    await expect(verify("anything")).resolves.toEqual(expected);
    // A caller mutating one result cannot widen the next.
    (await verify(""))!.scopes.push("acp:run");
    await expect(verify("")).resolves.toEqual(expected);
  });
});
