/**
 * Traceability spine query tests — Epic #207 (#229).
 *
 * Injected fake Prisma; no DB. Covers the assembled requirement→spec→code
 * chain, the empty-spec branch, the 404, and the reverse file lookup.
 */
import { describe, expect, it, vi } from "vitest";
import { getRequirementChain, getRequirementsForFile } from "./traceability-spine.js";
import type { TraceabilityDeps } from "./traceability-spine.js";

function deps(p: Record<string, unknown>): TraceabilityDeps {
  return { prisma: p as unknown as TraceabilityDeps["prisma"] };
}

describe("getRequirementChain", () => {
  it("assembles specs + their code + direct code", async () => {
    const p = {
      requirement: { findFirst: vi.fn().mockResolvedValue({ id: "req-1", title: "Login" }) },
      requirementSpecMapping: {
        findMany: vi.fn().mockResolvedValue([
          {
            specDocumentId: "spec-1",
            confidence: 0.9,
            source: "derived",
            specDocument: { title: "Auth Spec" },
          },
        ]),
      },
      specCodeMapping: {
        findMany: vi.fn().mockResolvedValue([
          {
            specDocumentId: "spec-1",
            codeSymbolId: "sym-1",
            filePath: "src/auth.ts",
            startLine: 1,
            endLine: 9,
            confidence: 0.8,
            source: "derived",
          },
        ]),
      },
      requirementCodeMapping: {
        findMany: vi.fn().mockResolvedValue([
          {
            codeSymbolId: "sym-2",
            filePath: "src/login.ts",
            startLine: 3,
            endLine: 4,
            confidence: 0.6,
            source: "semantic",
          },
        ]),
      },
    };

    const chain = await getRequirementChain("proj-1", "req-1", deps(p));
    expect(chain.requirementTitle).toBe("Login");
    expect(chain.specs).toHaveLength(1);
    expect(chain.specs[0]).toMatchObject({ specTitle: "Auth Spec", confidence: 0.9 });
    expect(chain.specs[0].code[0].filePath).toBe("src/auth.ts");
    expect(chain.directCode[0].filePath).toBe("src/login.ts");
  });

  it("404s for an unknown requirement", async () => {
    const p = { requirement: { findFirst: vi.fn().mockResolvedValue(null) } };
    await expect(getRequirementChain("proj-1", "ghost", deps(p))).rejects.toMatchObject({
      statusCode: 404,
      code: "REQUIREMENT_NOT_FOUND",
    });
  });

  it("skips the spec-code query when there are no specs", async () => {
    const specCodeFindMany = vi.fn();
    const p = {
      requirement: { findFirst: vi.fn().mockResolvedValue({ id: "req-1", title: "X" }) },
      requirementSpecMapping: { findMany: vi.fn().mockResolvedValue([]) },
      specCodeMapping: { findMany: specCodeFindMany },
      requirementCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const chain = await getRequirementChain("proj-1", "req-1", deps(p));
    expect(chain.specs).toEqual([]);
    expect(chain.directCode).toEqual([]);
    expect(specCodeFindMany).not.toHaveBeenCalled();
  });

  it("defaults a missing spec title to null", async () => {
    const p = {
      requirement: { findFirst: vi.fn().mockResolvedValue({ id: "req-1", title: "X" }) },
      requirementSpecMapping: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { specDocumentId: "s1", confidence: 0.5, source: "manual", specDocument: null },
          ]),
      },
      specCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
      requirementCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const chain = await getRequirementChain("proj-1", "req-1", deps(p));
    expect(chain.specs[0].specTitle).toBeNull();
    expect(chain.specs[0].code).toEqual([]);
  });
});

describe("getRequirementsForFile", () => {
  it("unions direct + spec-derived requirements, deduped", async () => {
    const p = {
      requirementCodeMapping: {
        findMany: vi.fn().mockResolvedValue([{ requirementId: "req-1" }]),
      },
      specCodeMapping: {
        findMany: vi.fn().mockResolvedValue([{ specDocumentId: "spec-1" }]),
      },
      requirementSpecMapping: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ requirementId: "req-1" }, { requirementId: "req-2" }]),
      },
    };
    const out = await getRequirementsForFile("proj-1", "src/auth.ts", deps(p));
    expect(out.sort()).toEqual(["req-1", "req-2"]);
  });

  it("skips the spec walk when no spec maps the file", async () => {
    const reqSpecFindMany = vi.fn();
    const p = {
      requirementCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
      specCodeMapping: { findMany: vi.fn().mockResolvedValue([]) },
      requirementSpecMapping: { findMany: reqSpecFindMany },
    };
    const out = await getRequirementsForFile("proj-1", "x.ts", deps(p));
    expect(out).toEqual([]);
    expect(reqSpecFindMany).not.toHaveBeenCalled();
  });
});
