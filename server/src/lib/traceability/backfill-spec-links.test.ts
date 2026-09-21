/**
 * Spec-link backfill tests — Epic #207 (#228).
 *
 * The derivation (`deriveSpecLinks`) is pure; `applyBackfill` is exercised with
 * an in-memory writer to assert idempotent create-vs-skip accounting.
 */
import { describe, expect, it, vi } from "vitest";
import {
  applyBackfill,
  deriveSpecLinks,
  extractScopePaths,
  loadBackfillData,
  MIN_LINK_CONFIDENCE,
  pathOverlap,
  prismaWriter,
  runBackfill,
  type BackfillData,
  type BackfillWriter,
} from "./backfill-spec-links.js";

describe("pathOverlap", () => {
  it("is 0 when either set is empty", () => {
    expect(pathOverlap(new Set(), new Set(["a"]))).toBe(0);
    expect(pathOverlap(new Set(["a"]), new Set())).toBe(0);
  });
  it("computes Jaccard similarity", () => {
    expect(pathOverlap(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
    expect(pathOverlap(new Set(["a"]), new Set(["a"]))).toBe(1);
  });
});

describe("extractScopePaths", () => {
  it("returns [] for null / malformed JSON", () => {
    expect(extractScopePaths(null)).toEqual([]);
    expect(extractScopePaths("{not json")).toEqual([]);
    expect(extractScopePaths("123")).toEqual([]);
  });
  it("reads modulePaths / filePaths / paths arrays", () => {
    expect(extractScopePaths(JSON.stringify({ modulePaths: ["a.ts", 5, "b.ts"] }))).toEqual([
      "a.ts",
      "b.ts",
    ]);
    expect(extractScopePaths(JSON.stringify({ filePaths: ["c.ts"] }))).toEqual(["c.ts"]);
    expect(extractScopePaths(JSON.stringify({ paths: ["d.ts"] }))).toEqual(["d.ts"]);
    expect(extractScopePaths(JSON.stringify({ other: ["x"] }))).toEqual([]);
  });
});

describe("deriveSpecLinks", () => {
  const data: BackfillData = {
    projectId: "proj-1",
    specs: [
      { id: "spec-1", filePaths: ["src/auth.ts", "src/token.ts"] },
      { id: "spec-2", filePaths: ["src/unrelated.ts"] },
    ],
    requirements: [
      {
        id: "req-1",
        code: [
          { codeSymbolId: "sym-1", filePath: "src/auth.ts", startLine: 1, endLine: 5 },
          { codeSymbolId: null, filePath: "src/auth.ts", startLine: null, endLine: null },
        ],
      },
      { id: "req-2", code: [] }, // no code spine → no links
    ],
  };

  it("links a requirement to a spec when their code paths overlap", () => {
    const { reqSpecLinks, specCode } = deriveSpecLinks(data);
    const link = reqSpecLinks.find((l) => l.specDocumentId === "spec-1");
    expect(link).toMatchObject({ requirementId: "req-1" });
    expect(link!.confidence).toBeGreaterThan(0);
    // spec-2 shares nothing with req-1 → no link.
    expect(reqSpecLinks.some((l) => l.specDocumentId === "spec-2")).toBe(false);
    // req-2 has no code → contributes nothing.
    expect(reqSpecLinks.every((l) => l.requirementId !== "req-2")).toBe(true);
    // spec-1 inherits the requirement's code, deduped by symbol|path.
    expect(specCode.get("spec-1")).toHaveLength(2);
  });

  it("drops links below MIN_LINK_CONFIDENCE", () => {
    const sparse: BackfillData = {
      projectId: "p",
      specs: [{ id: "s", filePaths: Array.from({ length: 100 }, (_, i) => `f${i}.ts`) }],
      requirements: [
        {
          id: "r",
          code: [{ codeSymbolId: null, filePath: "f0.ts", startLine: null, endLine: null }],
        },
      ],
    };
    // Overlap = 1 / 100 = 0.01 < MIN_LINK_CONFIDENCE (0.1) → no link.
    expect(MIN_LINK_CONFIDENCE).toBe(0.1);
    expect(deriveSpecLinks(sparse).reqSpecLinks).toHaveLength(0);
  });

  it("yields nothing for an empty project", () => {
    const { reqSpecLinks, specCode } = deriveSpecLinks({
      projectId: "p",
      specs: [],
      requirements: [],
    });
    expect(reqSpecLinks).toEqual([]);
    expect(specCode.size).toBe(0);
  });
});

describe("applyBackfill", () => {
  const data: BackfillData = {
    projectId: "proj-1",
    specs: [{ id: "spec-1", filePaths: ["a.ts"] }],
    requirements: [
      { id: "req-1", code: [{ codeSymbolId: "s", filePath: "a.ts", startLine: 1, endLine: 2 }] },
    ],
  };

  function memWriter(existingLinks = new Set<string>(), existingCode = 0): BackfillWriter {
    return {
      ensureRequirementSpecLink: vi.fn(async (link) => {
        const key = `${link.requirementId}:${link.specDocumentId}`;
        if (existingLinks.has(key)) return false;
        existingLinks.add(key);
        return true;
      }),
      writeSpecCode: vi.fn(async () => {}),
      countDerivedSpecCode: vi.fn(async () => existingCode),
    };
  }

  it("creates links on a first run", async () => {
    const out = await applyBackfill(data, memWriter());
    expect(out).toMatchObject({
      specsConsidered: 1,
      requirementSpecLinksCreated: 1,
      requirementSpecLinksSkipped: 0,
      specCodeLinksCreated: 1,
      specCodeLinksSkipped: 0,
    });
  });

  it("is idempotent: a re-run skips existing links", async () => {
    const out = await applyBackfill(data, memWriter(new Set(["req-1:spec-1"]), 1));
    expect(out.requirementSpecLinksCreated).toBe(0);
    expect(out.requirementSpecLinksSkipped).toBe(1);
    expect(out.specCodeLinksCreated).toBe(0);
    expect(out.specCodeLinksSkipped).toBe(1);
  });
});

describe("prismaWriter", () => {
  it("skips an existing requirement→spec link and creates a missing one", async () => {
    const create = vi.fn(async () => ({}));
    const findFirst = vi.fn().mockResolvedValueOnce({ id: "x" }).mockResolvedValueOnce(null);
    const prisma = {
      requirementSpecMapping: { findFirst, create },
      specCodeMapping: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn(async () => ({})),
        createMany: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    } as never;
    const writer = prismaWriter(prisma);
    const link = { requirementId: "r", specDocumentId: "s", confidence: 0.5 };

    expect(await writer.ensureRequirementSpecLink(link, "p")).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(await writer.ensureRequirementSpecLink(link, "p")).toBe(true);
    expect(create).toHaveBeenCalledOnce();

    await writer.writeSpecCode("s", "p", []);
    expect(await writer.countDerivedSpecCode("s")).toBe(0);
  });
});

describe("loadBackfillData + runBackfill", () => {
  function prismaSnapshot() {
    return {
      generatedDocument: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: "spec-1", scopeFilter: JSON.stringify({ filePaths: ["a.ts"] }) },
          ]),
      },
      requirement: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "req-1",
            codeMappings: [{ codeSymbolId: "s", filePath: "a.ts", startLine: 1, endLine: 2 }],
          },
        ]),
      },
      requirementSpecMapping: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      specCodeMapping: {
        count: vi.fn().mockResolvedValue(0),
        deleteMany: vi.fn().mockResolvedValue({}),
        createMany: vi.fn().mockResolvedValue({}),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    } as never;
  }

  it("loadBackfillData maps specs + requirement code mappings", async () => {
    const p = prismaSnapshot();
    const data = await loadBackfillData("proj-1", p);
    expect(data.specs).toEqual([{ id: "spec-1", filePaths: ["a.ts"] }]);
    expect(data.requirements[0].code[0].filePath).toBe("a.ts");
  });

  it("runBackfill derives + persists links end to end", async () => {
    const p = prismaSnapshot();
    const out = await runBackfill("proj-1", { prisma: p });
    expect(out.requirementSpecLinksCreated).toBe(1);
    expect(out.specCodeLinksCreated).toBe(1);
  });
});
