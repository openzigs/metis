/**
 * Primary repo service tests — Epic #640 / sub-issue #641.
 *
 * Tests setPrimaryRepo(), getPrimaryRepo(), and the atomic swap logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RepoRow {
  id: string;
  projectId: string;
  label: string;
  provider: string;
  ownerOrOrg: string;
  repoName: string;
  defaultBranch: string;
  isPrimary: boolean;
  apiBaseUrl: string | null;
  secretId: string | null;
  status: string;
  errorMessage: string | null;
  lastTestedAt: Date | null;
  lastIngestAt: Date | null;
  lastCommitSha: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const rows = new Map<string, RepoRow>();
let nextId = 0;

function makeRow(overrides: Partial<RepoRow> = {}): RepoRow {
  nextId += 1;
  return {
    id: `repo_${nextId}`,
    projectId: "proj_1",
    label: `repo-${nextId}`,
    provider: "github",
    ownerOrOrg: "acme",
    repoName: `repo-${nextId}`,
    defaultBranch: "main",
    isPrimary: false,
    apiBaseUrl: null,
    secretId: null,
    status: "pending",
    errorMessage: null,
    lastTestedAt: null,
    lastIngestAt: null,
    lastCommitSha: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    repoConnection: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].filter((r) => {
          if (r.deletedAt) return false;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        }),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const r of rows.values()) {
          if (r.deletedAt) continue;
          let ok = true;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if (k === "OR") continue; // skip complex where for secret lookup
            if ((r as unknown as Record<string, unknown>)[k] !== v) ok = false;
          }
          if (ok) return r;
        }
        return null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        return r;
      }),
      create: vi.fn(async ({ data }: { data: Partial<RepoRow> }) => {
        nextId += 1;
        const row: RepoRow = makeRow({ id: `repo_${nextId}`, ...data });
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RepoRow> }) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        const next = { ...r, ...data, updatedAt: new Date() } as RepoRow;
        rows.set(where.id, next);
        return next;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Partial<RepoRow> }) => {
          let count = 0;
          for (const r of rows.values()) {
            if (r.deletedAt) continue;
            let match = true;
            for (const [k, v] of Object.entries(where)) {
              if (k === "deletedAt") continue;
              if ((r as unknown as Record<string, unknown>)[k] !== v) match = false;
            }
            if (match) {
              Object.assign(r, data, { updatedAt: new Date() });
              count++;
            }
          }
          return { count };
        },
      ),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const r of rows.values()) {
          if (r.deletedAt) continue;
          let match = true;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) match = false;
          }
          if (match) count++;
        }
        return count;
      }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => {
      const results = [];
      for (const op of ops) results.push(await op);
      return results;
    }),
    auditLog: { create: vi.fn(async () => ({})) },
    secret: {
      findFirst: vi.fn(async () => null),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "api.github.com",
    address: "140.82.114.6",
    family: 4 as const,
  })),
  makePinnedLookup: vi.fn(() => undefined),
}));
vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async () => null),
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: vi.fn(() => ({})),
}));

import { setPrimaryRepo, getPrimaryRepo } from "../src/lib/connectors/repo/repo-service.js";

describe("setPrimaryRepo", () => {
  beforeEach(() => {
    rows.clear();
    nextId = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it("sets a repo as primary and clears previous primary", async () => {
    const r1 = makeRow({ id: "r1", projectId: "p1", isPrimary: true });
    const r2 = makeRow({ id: "r2", projectId: "p1", isPrimary: false });
    rows.set("r1", r1);
    rows.set("r2", r2);

    const result = await setPrimaryRepo("p1", "r2", "user1");
    expect(result.isPrimary).toBe(true);
    expect(result.id).toBe("r2");
    // Old primary should be cleared
    expect(rows.get("r1")!.isPrimary).toBe(false);
    expect(rows.get("r2")!.isPrimary).toBe(true);
  });

  it("returns as-is when already primary (no-op)", async () => {
    const r1 = makeRow({ id: "r1", projectId: "p1", isPrimary: true });
    rows.set("r1", r1);

    const result = await setPrimaryRepo("p1", "r1", "user1");
    expect(result.isPrimary).toBe(true);
    expect(result.id).toBe("r1");
  });

  it("throws 404 when connector not found", async () => {
    await expect(setPrimaryRepo("p1", "nonexistent", "user1")).rejects.toThrow("not found");
  });

  it("works when no previous primary exists", async () => {
    const r1 = makeRow({ id: "r1", projectId: "p1", isPrimary: false });
    rows.set("r1", r1);

    const result = await setPrimaryRepo("p1", "r1", "user1");
    expect(result.isPrimary).toBe(true);
  });

  it("does not affect repos in other projects", async () => {
    const r1 = makeRow({ id: "r1", projectId: "p1", isPrimary: true });
    const r2 = makeRow({ id: "r2", projectId: "p2", isPrimary: true });
    const r3 = makeRow({ id: "r3", projectId: "p1", isPrimary: false });
    rows.set("r1", r1);
    rows.set("r2", r2);
    rows.set("r3", r3);

    await setPrimaryRepo("p1", "r3", "user1");
    // p2's primary should be untouched
    expect(rows.get("r2")!.isPrimary).toBe(true);
    // p1 old primary should be cleared, new should be set
    expect(rows.get("r1")!.isPrimary).toBe(false);
    expect(rows.get("r3")!.isPrimary).toBe(true);
  });
});

describe("getPrimaryRepo", () => {
  beforeEach(() => {
    rows.clear();
    nextId = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns the primary repo when one exists", async () => {
    const r1 = makeRow({ id: "r1", projectId: "p1", isPrimary: true });
    const r2 = makeRow({ id: "r2", projectId: "p1", isPrimary: false });
    rows.set("r1", r1);
    rows.set("r2", r2);

    const result = await getPrimaryRepo("p1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("r1");
    expect(result!.isPrimary).toBe(true);
  });

  it("returns null when no primary repo is set", async () => {
    const r1 = makeRow({ id: "r1", projectId: "p1", isPrimary: false });
    rows.set("r1", r1);

    const result = await getPrimaryRepo("p1");
    expect(result).toBeNull();
  });

  it("returns null for empty project", async () => {
    const result = await getPrimaryRepo("empty-project");
    expect(result).toBeNull();
  });
});
