/**
 * Vault persistence tests using a mocked Prisma client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secretRows: Array<Record<string, unknown>> = [];
let nextId = 1;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    secret: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `sec_${nextId++}`,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        secretRows.push(row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; deletedAt: null } }) => {
        return secretRows.find((r) => r.id === where.id && r.deletedAt === null) ?? null;
      }),
      findMany: vi.fn(
        async ({ where }: { where: { deletedAt: null; name?: { startsWith: string } } }) => {
          return secretRows.filter((r) => {
            if (r.deletedAt !== null) return false;
            if (where.name?.startsWith) return (r.name as string).startsWith(where.name.startsWith);
            return true;
          });
        },
      ),
      // Honours a `deletedAt` filter in `where` the way Prisma does (#106): no
      // matching row is a `P2025`, and nothing is written.
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; deletedAt?: null };
          data: Record<string, unknown>;
        }) => {
          const row = secretRows.find(
            (r) =>
              r.id === where.id && (!("deletedAt" in where) || r.deletedAt === where.deletedAt),
          );
          if (!row) {
            throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
          }
          Object.assign(row, data);
          row.updatedAt = new Date();
          return row;
        },
      ),
      // #93 — keyed on the unique `name`, soft-deleted rows included, as the
      // real index is.
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { name: string };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const row = secretRows.find((r) => r.name === where.name);
          if (row) {
            Object.assign(row, update);
            row.updatedAt = new Date();
            return row;
          }
          const created = {
            id: `sec_${nextId++}`,
            deletedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
          secretRows.push(created);
          return created;
        },
      ),
    },
  },
}));

import { SecretNotFoundError, VaultService } from "../src/lib/vault/vault-service.js";
import { prisma } from "../src/lib/prisma.js";

const MASTER = Buffer.alloc(32, 7).toString("base64");

beforeEach(() => {
  secretRows.length = 0;
  nextId = 1;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("VaultService persistence", () => {
  it("creates, reads, lists, rotates, and deletes secrets", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    const created = await v.create("github-token", "gho_xxx", "global", {
      description: "GH PAT",
      createdById: null,
    });
    expect(created.label).toBe("github-token");
    expect(created.scope).toBe("global");

    const summaries = await v.list();
    expect(summaries).toHaveLength(1);
    // list() never includes plaintext.
    expect(JSON.stringify(summaries)).not.toContain("gho_xxx");

    const read = await v.read(created.id);
    expect(read.plaintext).toBe("gho_xxx");

    const rotated = await v.rotate(created.id, "gho_yyy");
    expect(rotated.id).toBe(created.id);
    const reRead = await v.read(created.id);
    expect(reRead.plaintext).toBe("gho_yyy");

    await v.delete(created.id);
    const after = await v.list();
    expect(after).toHaveLength(0);
  });

  it("scopes secrets correctly", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    await v.create("api-key", "global-secret", "global");
    await v.create("api-key", "project-secret", "project");
    const all = await v.list();
    expect(all.map((s) => s.scope).sort()).toEqual(["global", "project"]);
    const onlyProject = await v.list("project");
    expect(onlyProject).toHaveLength(1);
    expect(onlyProject[0].scope).toBe("project");
  });

  it("rejects empty labels", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    await expect(v.create("   ", "x")).rejects.toThrow(/label/);
  });

  // Review of PR #259 — rotate must not write into a soft-deleted row: the
  // caller could otherwise "rotate" a credential every reader treats as gone.
  it("refuses to rotate a soft-deleted secret and leaves its ciphertext untouched", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    const created = await v.create("jira-token", "old", "project");
    await v.delete(created.id);
    const row = secretRows.find((r) => r.id === created.id)!;
    const cipherBefore = row.ciphertext;

    await expect(v.rotate(created.id, "new")).rejects.toBeInstanceOf(SecretNotFoundError);
    expect(row.ciphertext).toBe(cipherBefore);
  });

  it("refuses to rotate a secret that never existed", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    await expect(v.rotate("missing", "new")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("any other store failure from rotate propagates unchanged", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    const created = await v.create("jira-token", "old", "project");
    const boom = new Error("database is locked");
    vi.mocked(prisma.secret.update).mockRejectedValueOnce(boom);
    await expect(v.rotate(created.id, "new")).rejects.toBe(boom);
  });

  it("throws when reading a non-existent secret", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    await expect(v.read("missing")).rejects.toThrow(/not found/);
  });
});

/** #93 — create-or-rotate decided by the unique `name`, not by a prior read. */
describe("VaultService.upsert", () => {
  const p2002 = () =>
    Object.assign(new Error("Unique constraint failed on the fields: (`name`)"), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
    });

  it("creates the secret on first write", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    const s = await v.upsert("TOKEN", "one", "global", { description: "d", createdById: "u1" });
    expect(s.label).toBe("TOKEN");
    expect(secretRows).toHaveLength(1);
    expect((await v.read(s.id)).plaintext).toBe("one");
  });

  it("revives a soft-deleted secret under the same name instead of creating a second row", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    const first = await v.create("TOKEN", "one", "global");
    await v.delete(first.id);
    expect(await v.list()).toHaveLength(0);

    const again = await v.upsert("TOKEN", "two", "global");
    expect(again.id).toBe(first.id);
    expect(secretRows).toHaveLength(1);
    // Read back through the paths a consumer uses: live, listed, new plaintext.
    expect(await v.list("global")).toHaveLength(1);
    expect((await v.read(again.id)).plaintext).toBe("two");
  });

  it("retries once when a concurrent writer wins the unique index", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    vi.mocked(prisma.secret.upsert).mockRejectedValueOnce(p2002());
    const s = await v.upsert("TOKEN", "x", "global");
    expect(s.label).toBe("TOKEN");
    expect(prisma.secret.upsert).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry rather than looping", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    vi.mocked(prisma.secret.upsert).mockRejectedValueOnce(p2002()).mockRejectedValueOnce(p2002());
    await expect(v.upsert("TOKEN", "x", "global")).rejects.toMatchObject({ code: "P2002" });
    expect(prisma.secret.upsert).toHaveBeenCalledTimes(2);
  });

  it("does not retry an error that is not a unique violation", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    vi.mocked(prisma.secret.upsert).mockRejectedValueOnce(new Error("db down"));
    await expect(v.upsert("TOKEN", "x", "global")).rejects.toThrow("db down");
    expect(prisma.secret.upsert).toHaveBeenCalledTimes(1);
  });

  it("rejects empty labels", async () => {
    const v = new VaultService({ masterKey: MASTER, isProduction: false });
    await expect(v.upsert("  ", "x")).rejects.toThrow(/label/);
  });
});
