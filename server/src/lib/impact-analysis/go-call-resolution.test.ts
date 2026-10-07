/**
 * #791 — Go call binding for impact analysis. Shapes are Miniflux v2.3.3's:
 * handlers call `h.store.X(…)`, recorded by the parser as a bare `X` with no
 * `toSymbolId`, and the storage method is a plain `function` symbol.
 */
import { describe, expect, it, vi } from "vitest";
import {
  goPackageDir,
  loadResolvedGoCalls,
  resolveGoCalls,
  type GoCallable,
  type GoImport,
} from "./go-call-resolution.js";

const STORAGE = "miniflux.app/v2/internal/storage";

const callables: GoCallable[] = [
  { id: "set-status", name: "SetEntriesStatus", filePath: "internal/storage/entry.go" },
  { id: "mark-all", name: "MarkAllAsRead", filePath: "internal/storage/entry.go" },
  { id: "client-mark-all", name: "MarkAllAsRead", filePath: "client/client.go" },
  { id: "before-date", name: "MarkAllAsReadBeforeDate", filePath: "internal/storage/entry.go" },
  { id: "helper", name: "newHelper", filePath: "internal/fever/helper.go" },
  { id: "test-helper", name: "fixture", filePath: "internal/storage/entry_test.go" },
  { id: "dup-a", name: "Dup", filePath: "internal/storage/a.go" },
  { id: "dup-b", name: "Dup", filePath: "internal/model/b.go" },
];

const imports: GoImport[] = [
  // The field `h.store` is declared in handler.go, so only that file imports storage.
  { filePath: "internal/fever/handler.go", importPath: STORAGE },
  { filePath: "internal/googlereader/handler.go", importPath: STORAGE },
  { filePath: "internal/googlereader/handler.go", importPath: "miniflux.app/v2/internal/model" },
];

describe("goPackageDir", () => {
  it("is the directory of the file, or empty at the root", () => {
    expect(goPackageDir("internal/storage/entry.go")).toBe("internal/storage");
    expect(goPackageDir("main.go")).toBe("");
  });
});

describe("resolveGoCalls (#791)", () => {
  it("binds a call through an imported package to its only declaration", () => {
    const out = resolveGoCalls(
      [
        {
          fromSymbolId: "fever-write-items",
          filePath: "internal/fever/handler.go",
          toQualifiedName: "SetEntriesStatus",
        },
      ],
      callables,
      imports,
    );
    expect(out).toEqual([{ fromSymbolId: "fever-write-items", toSymbolId: "set-status" }]);
  });

  it("pools imports across the files of one package", () => {
    // writeitems.go has no import of storage of its own; handler.go does.
    const out = resolveGoCalls(
      [
        {
          fromSymbolId: "w",
          filePath: "internal/fever/writeitems.go",
          toQualifiedName: "h.store.MarkAllAsReadBeforeDate",
        },
      ],
      callables,
      imports,
    );
    expect(out).toEqual([{ fromSymbolId: "w", toSymbolId: "before-date" }]);
  });

  it("disambiguates a shared name by what the caller's package imports", () => {
    // `client.MarkAllAsRead` exists too, but the fever package never imports `client`.
    const out = resolveGoCalls(
      [
        {
          fromSymbolId: "groups",
          filePath: "internal/fever/handler.go",
          toQualifiedName: "MarkAllAsRead",
        },
      ],
      callables,
      imports,
    );
    expect(out).toEqual([{ fromSymbolId: "groups", toSymbolId: "mark-all" }]);
  });

  it("binds a same-package call without an import", () => {
    const out = resolveGoCalls(
      [{ fromSymbolId: "h", filePath: "internal/fever/handler.go", toQualifiedName: "newHelper" }],
      callables,
      [],
    );
    expect(out).toEqual([{ fromSymbolId: "h", toSymbolId: "helper" }]);
  });

  it("leaves a call unresolved when two visible packages declare the name", () => {
    const out = resolveGoCalls(
      [{ fromSymbolId: "g", filePath: "internal/googlereader/handler.go", toQualifiedName: "Dup" }],
      callables,
      imports,
    );
    expect(out).toEqual([]);
  });

  it("never binds to a package the caller cannot see, or to an unknown name", () => {
    const out = resolveGoCalls(
      [
        { fromSymbolId: "x", filePath: "cmd/main.go", toQualifiedName: "SetEntriesStatus" },
        { fromSymbolId: "y", filePath: "internal/fever/handler.go", toQualifiedName: "Println" },
      ],
      callables,
      imports,
    );
    expect(out).toEqual([]);
  });

  it("does not offer a test file to a production caller, nor a function to itself", () => {
    const out = resolveGoCalls(
      [
        { fromSymbolId: "p", filePath: "internal/storage/entry.go", toQualifiedName: "fixture" },
        { fromSymbolId: "t", filePath: "internal/storage/x_test.go", toQualifiedName: "fixture" },
        {
          fromSymbolId: "set-status",
          filePath: "internal/storage/entry.go",
          toQualifiedName: "SetEntriesStatus",
        },
      ],
      callables,
      [],
    );
    expect(out).toEqual([{ fromSymbolId: "t", toSymbolId: "test-helper" }]);
  });
});

describe("loadResolvedGoCalls", () => {
  it("reads nothing else for a project with no Go functions", async () => {
    const prisma = {
      codeSymbol: { findMany: vi.fn().mockResolvedValue([]) },
      codeEdge: { findMany: vi.fn() },
    };
    expect(await loadResolvedGoCalls(prisma as never, "p")).toEqual([]);
    expect(prisma.codeEdge.findMany).not.toHaveBeenCalled();
  });

  it("resolves the project's unresolved Go calls from its rows", async () => {
    const edges = vi
      .fn()
      .mockResolvedValueOnce([
        {
          fromSymbolId: "gr",
          filePath: "internal/googlereader/handler.go",
          toQualifiedName: "MarkAllAsReadBeforeDate",
        },
        { fromSymbolId: "gr", filePath: "internal/googlereader/handler.go", toQualifiedName: null },
      ])
      .mockResolvedValueOnce([
        { filePath: "internal/googlereader/handler.go", toQualifiedName: STORAGE },
        { filePath: "internal/googlereader/handler.go", toQualifiedName: null },
      ]);
    const prisma = {
      codeSymbol: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "before-date",
            qualifiedName: "internal/storage/entry.go::MarkAllAsReadBeforeDate",
            filePath: "internal/storage/entry.go",
          },
        ]),
      },
      codeEdge: { findMany: edges },
    };
    expect(await loadResolvedGoCalls(prisma as never, "p")).toEqual([
      { fromSymbolId: "gr", toSymbolId: "before-date" },
    ]);
    expect(edges.mock.calls[0][0].where).toMatchObject({
      projectId: "p",
      kind: "calls",
      toSymbolId: null,
    });
  });
});
