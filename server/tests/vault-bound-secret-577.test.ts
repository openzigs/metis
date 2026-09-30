/**
 * #577 — unit tests for `authorizeAndBindSecretRefs`: the #344 ownership check
 * and the #480 binding over ONE read of the secret table, so the ids bound are
 * the ids judged. The end-to-end race (delete + re-create between check and
 * write) per MCP write path is in mcp-secret-binding-toctou-577.sqlite.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  secrets: [] as Array<{
    id: string;
    name: string;
    createdById: string | null;
    deletedAt: Date | null;
  }>,
  findManyCalls: 0,
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    secret: {
      // A superset of live rows is all the binder needs: it refines in memory.
      findMany: vi.fn(async () => {
        state.findManyCalls += 1;
        return state.secrets.filter((s) => !s.deletedAt);
      }),
    },
  },
}));
const audit = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit }));

const { authorizeAndBindSecretRefs } = await import("../src/lib/vault/bound-secret.js");

const COORD = { userId: "u-coord", role: "coordinator" as const };
const ADMIN = { userId: "u-admin", role: "admin" as const };
const ctx = { target: { type: "mcp_server", id: "m1" } };
const attach = (after: string[], before: string[] = [], destinationChanged = true) => ({
  before,
  after,
  destinationChanged,
});
const secret = (id: string, name: string, createdById: string | null) =>
  state.secrets.push({ id, name, createdById, deletedAt: null });

beforeEach(() => {
  state.secrets.length = 0;
  state.findManyCalls = 0;
  vi.clearAllMocks();
});

describe("authorizeAndBindSecretRefs", () => {
  it("binds the caller's own secret from the single read that approved it", async () => {
    secret("s1", "global:alpha", "u-coord");
    secret("s2", "global:beta", "u-coord");
    expect(await authorizeAndBindSecretRefs(COORD, attach(["alpha", "s2", "alpha"]), ctx)).toEqual({
      alpha: "s1",
      s2: "s2",
    });
    expect(state.findManyCalls).toBe(1);
  });

  it("refuses (403, audited) a label that reaches another user's secret, binding nothing", async () => {
    secret("s1", "global:alpha", "u-coord");
    secret("s2", "project:alpha", "u-admin");
    await expect(authorizeAndBindSecretRefs(COORD, attach(["alpha"]), ctx)).rejects.toMatchObject({
      statusCode: 403,
      code: "SECRET_BINDING_FORBIDDEN",
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "vault.binding_refused", target: ctx.target }),
    );
  });

  it("refuses an ambiguous label the caller owns twice (409)", async () => {
    secret("s1", "global:alpha", "u-coord");
    secret("s2", "project:alpha", "u-coord");
    await expect(authorizeAndBindSecretRefs(COORD, attach(["alpha"]), ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: "VAULT_REF_AMBIGUOUS",
    });
  });

  it("keeps a kept reference's stored id, even to a deleted secret, when nothing moves", async () => {
    expect(
      await authorizeAndBindSecretRefs(COORD, attach(["gone"], ["gone"], false), ctx, {
        gone: "s-deleted",
      }),
    ).toEqual({ gone: "s-deleted" });
  });

  it("an admin (vault.reveal) is not judged, and binds from one read of the unkept refs", async () => {
    secret("s2", "project:alpha", "u-other");
    expect(
      await authorizeAndBindSecretRefs(ADMIN, attach(["alpha", "kept"]), ctx, { kept: "s9" }),
    ).toEqual({ alpha: "s2", kept: "s9" });
    expect(state.findManyCalls).toBe(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it("an admin whose references are all kept reads nothing", async () => {
    expect(await authorizeAndBindSecretRefs(ADMIN, attach(["kept"]), ctx, { kept: "s9" })).toEqual({
      kept: "s9",
    });
    expect(state.findManyCalls).toBe(0);
  });

  it("binds nothing and reads nothing when the write references no secret", async () => {
    expect(await authorizeAndBindSecretRefs(COORD, attach([]), ctx)).toEqual({});
    expect(state.findManyCalls).toBe(0);
  });
});
