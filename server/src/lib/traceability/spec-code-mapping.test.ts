/**
 * Spec ↔ Code mapping service tests — Epic #207 (#227).
 *
 * Injected fake Prisma; no DB. Covers scoping, nullable codeSymbol handling,
 * CRUD, and the idempotent `persistDerived` transaction path.
 */
import { describe, expect, it, vi } from "vitest";
import {
  create,
  listForProject,
  listForSpec,
  persistDerived,
  remove,
} from "./spec-code-mapping.js";
import type { SpecCodeMappingDeps } from "./spec-code-mapping.js";

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "scm-1",
    specDocumentId: "spec-1",
    projectId: "proj-1",
    codeSymbolId: "sym-1",
    filePath: "src/auth.ts",
    startLine: 10,
    endLine: 20,
    confidence: 0.7,
    source: "manual",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

function fakePrisma(
  opts: {
    spec?: { id: string } | null;
    symbol?: { id: string } | null;
    many?: unknown[];
    findFirstMapping?: { id: string } | null;
    withTx?: boolean;
  } = {},
) {
  const specCodeMapping = {
    findMany: vi.fn().mockResolvedValue(opts.many ?? [row()]),
    findFirst: vi
      .fn()
      .mockResolvedValue(
        opts.findFirstMapping === undefined ? { id: "scm-1" } : opts.findFirstMapping,
      ),
    create: vi.fn(async () => row()),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const base: Record<string, unknown> = {
    specCodeMapping,
    generatedDocument: {
      findFirst: vi.fn().mockResolvedValue(opts.spec === undefined ? { id: "spec-1" } : opts.spec),
    },
    codeSymbol: {
      findFirst: vi
        .fn()
        .mockResolvedValue(opts.symbol === undefined ? { id: "sym-1" } : opts.symbol),
    },
  };
  if (opts.withTx) {
    base.$transaction = vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops));
  }
  return base as typeof base & { specCodeMapping: typeof specCodeMapping };
}

function deps(p: ReturnType<typeof fakePrisma>): SpecCodeMappingDeps {
  return { prisma: p as unknown as SpecCodeMappingDeps["prisma"] };
}

describe("spec-code-mapping", () => {
  it("listForSpec returns shaped rows", async () => {
    const p = fakePrisma();
    const out = await listForSpec("proj-1", "spec-1", deps(p));
    expect(out[0]).toMatchObject({ filePath: "src/auth.ts", startLine: 10, codeSymbolId: "sym-1" });
  });

  it("listForSpec 404s for an unknown spec", async () => {
    const p = fakePrisma({ spec: null });
    await expect(listForSpec("proj-1", "x", deps(p))).rejects.toMatchObject({
      statusCode: 404,
      code: "SPEC_NOT_FOUND",
    });
  });

  it("listForProject returns all rows", async () => {
    const p = fakePrisma({ many: [row(), row({ id: "scm-2" })] });
    expect(await listForProject("proj-1", deps(p))).toHaveLength(2);
  });

  it("create persists a file-only (null symbol) hit without checking the symbol", async () => {
    const p = fakePrisma();
    await create("proj-1", "spec-1", { filePath: "src/x.ts", codeSymbolId: null }, deps(p));
    expect(
      (p as Record<string, { findFirst: ReturnType<typeof vi.fn> }>).codeSymbol.findFirst,
    ).not.toHaveBeenCalled();
    expect(p.specCodeMapping.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ codeSymbolId: null }) }),
    );
  });

  it("create validates a supplied symbol belongs to the project", async () => {
    const p = fakePrisma({ symbol: null });
    await expect(
      create("proj-1", "spec-1", { filePath: "src/x.ts", codeSymbolId: "ghost" }, deps(p)),
    ).rejects.toMatchObject({ statusCode: 404, code: "CODE_SYMBOL_NOT_FOUND" });
  });

  it("remove deletes after ownership check", async () => {
    const p = fakePrisma();
    await remove("proj-1", "spec-1", "scm-1", deps(p));
    expect(p.specCodeMapping.delete).toHaveBeenCalledWith({ where: { id: "scm-1" } });
  });

  it("remove 404s for a foreign mapping", async () => {
    const p = fakePrisma({ findFirstMapping: null });
    await expect(remove("proj-1", "spec-1", "x", deps(p))).rejects.toMatchObject({
      statusCode: 404,
      code: "SPEC_CODE_MAPPING_NOT_FOUND",
    });
  });

  it("persistDerived replaces derived rows inside a transaction when available", async () => {
    const p = fakePrisma({ withTx: true });
    await persistDerived(
      "proj-1",
      "spec-1",
      [{ codeSymbolId: "s1", filePath: "a.ts", startLine: 1, endLine: 2, confidence: 0.5 }],
      deps(p),
    );
    expect(p.specCodeMapping.deleteMany).toHaveBeenCalledWith({
      where: { specDocumentId: "spec-1", source: "derived" },
    });
    expect(p.specCodeMapping.createMany).toHaveBeenCalled();
    expect((p as Record<string, ReturnType<typeof vi.fn>>).$transaction).toHaveBeenCalledOnce();
  });

  it("persistDerived falls back to sequential ops without $transaction", async () => {
    const p = fakePrisma();
    await persistDerived("proj-1", "spec-1", [], deps(p));
    expect(p.specCodeMapping.deleteMany).toHaveBeenCalled();
    expect(p.specCodeMapping.createMany).toHaveBeenCalled();
  });
});
