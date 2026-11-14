/**
 * #2331 — the credential resolves to one live METIS user, or it is refused.
 * The real token rows are driven in `tests/mcp-metis-index-2331.sqlite.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  resolveAcpActor: vi.fn(),
}));
vi.mock("../../lib/prisma.js", () => ({ prisma: { user: { findUnique: m.findUnique } } }));
vi.mock("../../lib/acp/authz.js", async (original) => ({
  ...(await original<typeof import("../../lib/acp/authz.js")>()),
  resolveAcpActor: m.resolveAcpActor,
}));

const { resolveMcpCaller, McpAuthError, REFUSED_MESSAGE } = await import("./identity.js");

const verified = (scopes: string[]) => async () => ({ tokenId: "t1", userId: "u1", scopes });

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(McpAuthError);
    expect((err as Error).message).toBe(REFUSED_MESSAGE);
    return (err as InstanceType<typeof McpAuthError>).reason;
  }
  throw new Error("expected a refusal");
}

describe("resolveMcpCaller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
    m.resolveAcpActor.mockResolvedValue({ userId: "u1", role: "reader", workspaces: ["w1"] });
  });

  it("resolves a live token with acp:read to its user, role and workspaces", async () => {
    const caller = await resolveMcpCaller("metis_abc", verified(["acp:read"]));
    expect(caller).toEqual({
      userId: "u1",
      tokenId: "t1",
      actor: { userId: "u1", role: "reader", workspaces: ["w1"] },
    });
    expect(m.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { status: true, deletedAt: true },
    });
  });

  it("accepts the legacy acp:* wildcard", async () => {
    await expect(resolveMcpCaller("metis_abc", verified(["acp:*"]))).resolves.toMatchObject({
      userId: "u1",
    });
  });

  it("refuses an empty credential without asking the verifier", async () => {
    const verify = vi.fn();
    expect(await reason(resolveMcpCaller("", verify))).toBe("missing");
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses a credential that maps to no token", async () => {
    expect(await reason(resolveMcpCaller("shared-secret", async () => null))).toBe("invalid");
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a token without acp:read", async () => {
    expect(await reason(resolveMcpCaller("metis_abc", verified(["acp:run"])))).toBe("scope");
  });

  it.each([
    ["a disabled user", { status: "disabled", deletedAt: null }],
    ["a deleted user", { status: "active", deletedAt: new Date() }],
    ["a user row that is gone", null],
  ])("refuses the token of %s", async (_label, row) => {
    m.findUnique.mockResolvedValue(row);
    expect(await reason(resolveMcpCaller("metis_abc", verified(["acp:read"])))).toBe("inactive");
    expect(m.resolveAcpActor).not.toHaveBeenCalled();
  });
});
