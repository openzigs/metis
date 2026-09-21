/**
 * ACP API token service — create / list / verify / revoke.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  tokenHash: string;
  scopes: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}
const rows = new Map<string, Row>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    apiToken: {
      create: vi.fn(
        async ({ data }: { data: Omit<Row, "id" | "createdAt" | "lastUsedAt" | "revokedAt"> }) => {
          nextId += 1;
          const row: Row = {
            id: `tok_${nextId}`,
            createdAt: new Date(),
            lastUsedAt: null,
            revokedAt: null,
            expiresAt: data.expiresAt ?? null,
            ...data,
          };
          rows.set(row.id, row);
          return row;
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; tokenHash?: string } }) => {
        if (where.id) return rows.get(where.id) ?? null;
        if (where.tokenHash) {
          for (const r of rows.values()) if (r.tokenHash === where.tokenHash) return r;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        Array.from(rows.values())
          .filter((r) => r.userId === where.userId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data };
        rows.set(where.id, next);
        return next;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import {
  ApiTokenError,
  TOKEN_PREFIX,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  verifyApiToken,
} from "../src/lib/acp/api-tokens.js";

beforeEach(() => {
  rows.clear();
  nextId = 0;
});

afterEach(() => vi.clearAllMocks());

describe("createApiToken", () => {
  it("returns a metis_-prefixed plaintext + view", async () => {
    const t = await createApiToken({ userId: "u1", name: "ci", scopes: ["read"] });
    expect(t.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(t.token.length).toBeGreaterThan(20);
    expect(t.userId).toBe("u1");
    expect(t.name).toBe("ci");
    expect(t.scopes).toEqual(["read"]);
    expect(t.prefix).toBe(t.token.slice(0, 14));
  });
  it("rejects empty/long names", async () => {
    await expect(createApiToken({ userId: "u", name: "" })).rejects.toBeInstanceOf(ApiTokenError);
    await expect(createApiToken({ userId: "u", name: "x".repeat(200) })).rejects.toBeInstanceOf(
      ApiTokenError,
    );
  });
  it("rejects invalid expiresAt", async () => {
    await expect(
      createApiToken({ userId: "u", name: "n", expiresAt: "not a date" }),
    ).rejects.toBeInstanceOf(ApiTokenError);
  });
  it("filters non-string scopes", async () => {
    const t = await createApiToken({
      userId: "u",
      name: "n",
      scopes: ["ok", "", "x".repeat(200)] as string[],
    });
    expect(t.scopes).toEqual(["ok"]);
  });
});

describe("verifyApiToken", () => {
  it("returns null for unknown tokens", async () => {
    expect(await verifyApiToken("nope")).toBeNull();
    expect(await verifyApiToken(`${TOKEN_PREFIX}deadbeef`)).toBeNull();
  });
  it("returns null for revoked tokens", async () => {
    const t = await createApiToken({ userId: "u", name: "n" });
    await revokeApiToken("u", t.id);
    expect(await verifyApiToken(t.token)).toBeNull();
  });
  it("returns null for expired tokens", async () => {
    const t = await createApiToken({
      userId: "u",
      name: "n",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await verifyApiToken(t.token)).toBeNull();
  });
  it("returns scopes for valid tokens", async () => {
    const t = await createApiToken({ userId: "u", name: "n", scopes: ["a", "b"] });
    const v = await verifyApiToken(t.token);
    expect(v?.userId).toBe("u");
    expect(v?.scopes).toEqual(["a", "b"]);
  });
});

describe("listApiTokens / revokeApiToken", () => {
  it("lists tokens newest-first", async () => {
    await createApiToken({ userId: "u", name: "a" });
    // SQLite `createdAt` resolves to milliseconds; on fast hardware two
    // back-to-back inserts can land in the same tick, so `orderBy desc`
    // becomes ambiguous. A 2 ms gap guarantees a strict ordering.
    await new Promise((r) => setTimeout(r, 2));
    await createApiToken({ userId: "u", name: "b" });
    const list = await listApiTokens("u");
    expect(list.map((t) => t.name)).toEqual(["b", "a"]);
  });
  it("404s on revoking another user's token", async () => {
    const t = await createApiToken({ userId: "u1", name: "n" });
    await expect(revokeApiToken("u2", t.id)).rejects.toBeInstanceOf(ApiTokenError);
  });
  it("revoking twice is idempotent", async () => {
    const t = await createApiToken({ userId: "u", name: "n" });
    const r1 = await revokeApiToken("u", t.id);
    const r2 = await revokeApiToken("u", t.id);
    expect(r1.revokedAt).not.toBeNull();
    expect(r2.revokedAt).toBe(r1.revokedAt);
  });
});
