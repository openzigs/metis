/**
 * Requirement ↔ Spec mapping service tests — Epic #207 (#226).
 *
 * Injected fake Prisma; no DB. Covers scoping (404s), happy-path CRUD, the
 * dup-violation 409, and list ordering / join shaping.
 */
import { describe, expect, it, vi } from "vitest";
import { create, listForProject, listForRequirement, remove } from "./requirement-spec-mapping.js";
import type { RequirementSpecMappingDeps } from "./requirement-spec-mapping.js";

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "rsm-1",
    requirementId: "req-1",
    specDocumentId: "spec-1",
    projectId: "proj-1",
    confidence: 0.7,
    source: "manual",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    specDocument: { title: "Auth Spec" },
    ...over,
  };
}

function fakePrisma(
  opts: {
    requirement?: { id: string } | null;
    spec?: { id: string } | null;
    createImpl?: () => unknown;
    findFirstMapping?: { id: string } | null;
    many?: unknown[];
  } = {},
) {
  const requirementSpecMapping = {
    findMany: vi.fn().mockResolvedValue(opts.many ?? [row()]),
    findFirst: vi
      .fn()
      .mockResolvedValue(
        opts.findFirstMapping === undefined ? { id: "rsm-1" } : opts.findFirstMapping,
      ),
    create: vi.fn(opts.createImpl ?? (async () => row())),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    requirementSpecMapping,
    requirement: {
      findFirst: vi
        .fn()
        .mockResolvedValue(opts.requirement === undefined ? { id: "req-1" } : opts.requirement),
    },
    generatedDocument: {
      findFirst: vi.fn().mockResolvedValue(opts.spec === undefined ? { id: "spec-1" } : opts.spec),
    },
  };
}

function deps(p: ReturnType<typeof fakePrisma>): RequirementSpecMappingDeps {
  return { prisma: p as unknown as RequirementSpecMappingDeps["prisma"] };
}

describe("requirement-spec-mapping", () => {
  it("listForRequirement returns shaped rows with joined spec title", async () => {
    const p = fakePrisma();
    const out = await listForRequirement("proj-1", "req-1", deps(p));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "rsm-1",
      specTitle: "Auth Spec",
      source: "manual",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("listForRequirement 404s when the requirement is not in the project", async () => {
    const p = fakePrisma({ requirement: null });
    await expect(listForRequirement("proj-1", "missing", deps(p))).rejects.toMatchObject({
      statusCode: 404,
      code: "REQUIREMENT_NOT_FOUND",
    });
  });

  it("listForProject shapes a null spec title when the spec was removed", async () => {
    const p = fakePrisma({ many: [row({ specDocument: null })] });
    const out = await listForProject("proj-1", deps(p));
    expect(out[0].specTitle).toBeNull();
  });

  it("create defaults source to manual and returns the shaped row", async () => {
    const p = fakePrisma();
    const out = await create("proj-1", "req-1", { specDocumentId: "spec-1" }, deps(p));
    expect(out.specDocumentId).toBe("spec-1");
    expect(p.requirementSpecMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: "manual" }) }),
    );
  });

  it("create honours an explicit confidence + source", async () => {
    const p = fakePrisma({ createImpl: async () => row({ confidence: 0.4, source: "derived" }) });
    await create(
      "proj-1",
      "req-1",
      { specDocumentId: "spec-1", confidence: 0.4, source: "derived" },
      deps(p),
    );
    expect(p.requirementSpecMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ confidence: 0.4, source: "derived" }),
      }),
    );
  });

  it("create 404s when the spec is not in the project", async () => {
    const p = fakePrisma({ spec: null });
    await expect(create("proj-1", "req-1", { specDocumentId: "x" }, deps(p))).rejects.toMatchObject(
      { statusCode: 404, code: "SPEC_NOT_FOUND" },
    );
  });

  it("create maps a P2002 unique violation to a 409", async () => {
    const p = fakePrisma({
      createImpl: async () => {
        throw Object.assign(new Error("dup"), { code: "P2002" });
      },
    });
    await expect(
      create("proj-1", "req-1", { specDocumentId: "spec-1" }, deps(p)),
    ).rejects.toMatchObject({ statusCode: 409, code: "SPEC_MAPPING_EXISTS" });
  });

  it("create rethrows non-unique errors unchanged", async () => {
    const p = fakePrisma({
      createImpl: async () => {
        throw new Error("boom");
      },
    });
    await expect(create("proj-1", "req-1", { specDocumentId: "spec-1" }, deps(p))).rejects.toThrow(
      "boom",
    );
  });

  it("remove deletes after confirming ownership", async () => {
    const p = fakePrisma();
    await remove("proj-1", "req-1", "rsm-1", deps(p));
    expect(p.requirementSpecMapping.delete).toHaveBeenCalledWith({ where: { id: "rsm-1" } });
  });

  it("remove 404s when the mapping is not on the requirement", async () => {
    const p = fakePrisma({ findFirstMapping: null });
    await expect(remove("proj-1", "req-1", "nope", deps(p))).rejects.toMatchObject({
      statusCode: 404,
      code: "SPEC_MAPPING_NOT_FOUND",
    });
    expect(p.requirementSpecMapping.delete).not.toHaveBeenCalled();
  });
});
