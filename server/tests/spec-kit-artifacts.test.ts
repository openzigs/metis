/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the Spec Kit artifacts service (Epic #193).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ArtifactRow {
  id: string;
  projectId: string;
  name: string;
  content: string;
  version: number;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const rows = new Map<string, ArtifactRow>();
const projects = new Map<string, { specKitEnabled: boolean }>();
let nextId = 0;
const auditCalls: any[] = [];

function reset(): void {
  rows.clear();
  projects.clear();
  auditCalls.length = 0;
  nextId = 0;
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    specKitArtifact: {
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        const list = [...rows.values()].filter((r) => r.projectId === where.projectId);
        if (orderBy?.name === "asc") list.sort((a, b) => a.name.localeCompare(b.name));
        return list;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return rows.get(where.id) ?? null;
        if (where.projectId_name) {
          for (const r of rows.values()) {
            if (
              r.projectId === where.projectId_name.projectId &&
              r.name === where.projectId_name.name
            )
              return r;
          }
          return null;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        nextId++;
        const row: ArtifactRow = {
          id: `ska_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          projectId: data.projectId,
          name: data.name,
          content: data.content ?? "",
          version: data.version ?? 1,
          updatedById: data.updatedById ?? null,
        };
        rows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = rows.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      delete: vi.fn(async ({ where }: any) => {
        rows.delete(where.id);
      }),
    },
    project: {
      findUnique: vi.fn(async ({ where }: any) => projects.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const p = projects.get(where.id);
        if (!p) throw new Error("not found");
        Object.assign(p, data);
        return p;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: any) => {
    auditCalls.push(entry);
  }),
  getAuditService: vi.fn(() => ({ record: vi.fn() })),
}));

import {
  SpecKitArtifactError,
  deleteArtifact,
  getArtifact,
  isSpecKitEnabled,
  listArtifacts,
  setSpecKitEnabled,
  writeArtifact,
} from "../src/lib/spec-kit/artifacts.js";

beforeEach(() => {
  reset();
  projects.set("p1", { specKitEnabled: false });
});
afterEach(() => vi.clearAllMocks());

describe("isSpecKitEnabled / setSpecKitEnabled", () => {
  it("returns the project flag", async () => {
    expect(await isSpecKitEnabled("p1")).toBe(false);
  });

  it("throws 404 for an unknown project", async () => {
    await expect(isSpecKitEnabled("missing")).rejects.toMatchObject({
      status: 404,
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("flips the flag and writes an audit row", async () => {
    expect(await setSpecKitEnabled("p1", true, "u1")).toBe(true);
    expect(auditCalls[0]).toMatchObject({ action: "spec_kit.enabled" });
    expect(await setSpecKitEnabled("p1", false, "u1")).toBe(false);
    expect(auditCalls[1]).toMatchObject({ action: "spec_kit.disabled" });
  });
});

describe("writeArtifact", () => {
  it("creates a v1 row on first write", async () => {
    const a = await writeArtifact({ projectId: "p1", name: "spec.md", content: "hello" });
    expect(a.version).toBe(1);
    expect(a.content).toBe("hello");
  });

  it("bumps version on subsequent writes", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "v1" });
    const a2 = await writeArtifact({ projectId: "p1", name: "spec.md", content: "v2" });
    expect(a2.version).toBe(2);
  });

  it("rejects unknown artifact names", async () => {
    await expect(writeArtifact({ projectId: "p1", name: "evil.sh", content: "" })).rejects.toThrow(
      SpecKitArtifactError,
    );
  });

  it("rejects non-string content", async () => {
    await expect(
      writeArtifact({ projectId: "p1", name: "spec.md", content: 42 as unknown as string }),
    ).rejects.toMatchObject({ code: "SPEC_KIT_INVALID_CONTENT" });
  });

  it("rejects oversized content", async () => {
    await expect(
      writeArtifact({ projectId: "p1", name: "spec.md", content: "x".repeat(200_001) }),
    ).rejects.toMatchObject({ code: "SPEC_KIT_CONTENT_TOO_LARGE" });
  });

  it("emits an audit row tagged with version + name", async () => {
    await writeArtifact({ projectId: "p1", name: "plan.md", content: "x", actorId: "u1" });
    expect(auditCalls.find((c) => c.action === "spec_kit.artifact.written")).toMatchObject({
      metadata: { name: "plan.md", version: 1 },
    });
  });
});

describe("listArtifacts / getArtifact / deleteArtifact", () => {
  it("returns alphabetically-ordered DTOs", async () => {
    await writeArtifact({ projectId: "p1", name: "tasks.md", content: "t" });
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "s" });
    const list = await listArtifacts("p1");
    expect(list.map((a) => a.name)).toEqual(["spec.md", "tasks.md"]);
  });

  it("returns null for missing artifact", async () => {
    expect(await getArtifact("p1", "spec.md")).toBeNull();
  });

  it("deletes only when the row exists and audits the operation", async () => {
    await writeArtifact({ projectId: "p1", name: "spec.md", content: "x" });
    await deleteArtifact("p1", "spec.md", "u1");
    expect(await getArtifact("p1", "spec.md")).toBeNull();
    expect(auditCalls.find((c) => c.action === "spec_kit.artifact.deleted")).toBeTruthy();
  });

  it("delete is a no-op when missing", async () => {
    await expect(deleteArtifact("p1", "spec.md", "u1")).resolves.toBeUndefined();
  });

  it("getArtifact rejects unknown names", async () => {
    await expect(getArtifact("p1", "evil")).rejects.toThrow(SpecKitArtifactError);
  });
});
