import { describe, expect, it, vi } from "vitest";
import type {
  SeedSearcher,
  SeedSymbolLoader,
  StoredLinkRow,
} from "../../impact-analysis/change-seeds.js";
import {
  applyOpsToClone,
  assertSafeRepoPath,
  commentLineFor,
  directoryDistance,
  emptyTally,
  generateStalenessPatchSet,
  parseStalenessPatchSet,
  patchedFileSymbols,
  patchedGraphFiles,
  patchedSymbolRows,
  renamedPath,
  searchWithoutFiles,
  resolveInClone,
  stalenessPatchProblems,
  STALENESS_ISSUE,
  tallyFreshness,
  unrenamedFiles,
  StalenessRestoreError,
  withNoopReingest,
  withStalePatch,
  withoutFreshness,
  type CloneFiles,
  type PatchSymbolRow,
  type StalenessOp,
} from "./staleness.js";

const sym = (
  repo: string,
  filePath: string,
  qualifiedName: string,
  kind: string,
  startLine: number,
  endLine: number,
  language = "go",
): PatchSymbolRow => ({ repo, filePath, qualifiedName, kind, language, startLine, endLine });

// One repository: the answer files a.go and b.go in pkg/, neighbours in pkg/
// and pkg/sub/, a far file, a test file and a doc file.
const symbols: PatchSymbolRow[] = [
  sym("r", "pkg/a.go", "pkg/a.go", "module", 1, 40),
  sym("r", "pkg/a.go", "pkg/a.go::Short", "function", 2, 4),
  sym("r", "pkg/a.go", "pkg/a.go::Long", "function", 10, 30),
  sym("r", "pkg/a.go", "pkg/a.go::Big", "class", 5, 39),
  sym("r", "pkg/b.go", "pkg/b.go::B", "function", 1, 9),
  sym("r", "pkg/near.go", "pkg/near.go::N1", "function", 1, 3),
  sym("r", "pkg/near.go", "pkg/near.go::N2", "function", 4, 6),
  sym("r", "pkg/near2.go", "pkg/near2.go::M", "function", 1, 3),
  sym("r", "pkg/sub/deep.go", "pkg/sub/deep.go::D1", "function", 1, 3),
  sym("r", "pkg/sub/deep.go", "pkg/sub/deep.go::D2", "function", 4, 6),
  sym("r", "pkg/sub/deep.go", "pkg/sub/deep.go::D3", "function", 7, 9),
  sym("r", "far/x.go", "far/x.go::X1", "function", 1, 3),
  sym("r", "far/x.go", "far/x.go::X2", "function", 4, 6),
  sym("r", "far/x.go", "far/x.go::X3", "function", 7, 9),
  sym("r", "far/x.go", "far/x.go::X4", "function", 10, 12),
  sym("r", "pkg/a_test.go", "pkg/a_test.go::T", "function", 1, 9),
  sym("r", "pkg/README.md", "pkg/README.md", "module", 1, 9),
];

describe("generateStalenessPatchSet (#1834)", () => {
  it("edits every function of the first answer, renames the second answer, deletes the nearest busiest neighbour", () => {
    const set = generateStalenessPatchSet({
      corpus: "toy",
      items: [{ id: "I-1", expectedFiles: ["r:pkg/a.go", "r:pkg/b.go"] }],
      symbols,
    });
    expect(set).toMatchObject({ corpus: "toy", issue: STALENESS_ISSUE });
    expect(set.items["I-1"]).toEqual([
      // Every multi-line function, in line order; the class is not a function.
      {
        op: "edit",
        repo: "r",
        file: "pkg/a.go",
        symbol: "pkg/a.go::Short",
        afterLine: 2,
        text: commentLineFor("go"),
      },
      {
        op: "edit",
        repo: "r",
        file: "pkg/a.go",
        symbol: "pkg/a.go::Long",
        afterLine: 10,
        text: commentLineFor("go"),
      },
      { op: "rename", repo: "r", from: "pkg/b.go", to: "pkg/b_renamed.go" },
      // pkg/near.go: same directory, two symbols; pkg/near2.go has one; pkg/sub has three but is deeper.
      { op: "delete", repo: "r", file: "pkg/near.go" },
    ]);
  });

  it("with one answer, renames the nearest neighbour and deletes the next; never a test or doc file", () => {
    const set = generateStalenessPatchSet({
      corpus: "toy",
      items: [{ id: "I-1", expectedFiles: ["r:pkg/a.go"] }],
      symbols,
    });
    expect(set.items["I-1"]!.slice(2)).toEqual([
      { op: "rename", repo: "r", from: "pkg/near.go", to: "pkg/near_renamed.go" },
      // b.go is not an answer here: one symbol, like near2.go, and first by path.
      { op: "delete", repo: "r", file: "pkg/b.go" },
    ]);
  });

  it("falls back to a non-function symbol, uses a Python comment, and leaves out an item with nothing to edit", () => {
    const set = generateStalenessPatchSet({
      corpus: "toy",
      items: [
        { id: "PY", expectedFiles: ["p:m.py"] },
        { id: "NONE", expectedFiles: ["p:only-module.py", "p:not-in-graph.py"] },
      ],
      symbols: [
        sym("p", "m.py", "m.py::Thing", "class", 3, 20, "py"),
        sym("p", "m.py", "m.py::one_liner", "function", 1, 1, "py"),
        sym("p", "only-module.py", "only-module.py", "module", 1, 9, "py"),
      ],
    });
    expect(set.items.PY).toEqual([
      {
        op: "edit",
        repo: "p",
        file: "m.py",
        symbol: "m.py::Thing",
        afterLine: 3,
        text: "# metis-eval #1834: synthetic staleness edit",
      },
      { op: "rename", repo: "p", from: "only-module.py", to: "only-module_renamed.py" },
    ]);
    expect(set.items.NONE).toBeUndefined();
  });

  it("prefers a function body in a later answer file over an interface in the first, and renames the first", () => {
    const set = generateStalenessPatchSet({
      corpus: "toy",
      items: [{ id: "J", expectedFiles: ["j:Mapper.java", "j:Service.java"] }],
      symbols: [
        sym("j", "Mapper.java", "Mapper.java::Mapper", "interface", 3, 20, "java"),
        sym("j", "Mapper.java", "Mapper.java::Mapper::get", "method", 5, 5, "java"),
        sym("j", "Service.java", "Service.java::Service::get", "method", 8, 12, "java"),
      ],
    });
    expect(set.items.J!.slice(0, 2)).toEqual([
      expect.objectContaining({
        op: "edit",
        file: "Service.java",
        symbol: "Service.java::Service::get",
        afterLine: 8,
      }),
      { op: "rename", repo: "j", from: "Mapper.java", to: "Mapper_renamed.java" },
    ]);
  });

  it("edits the symbol the item's labels name before the longest one", () => {
    const set = generateStalenessPatchSet({
      corpus: "toy",
      items: [{ id: "J", expectedFiles: ["j:Service.java"], expectedSymbols: ["getItem"] }],
      symbols: [
        sym("j", "Service.java", "Service.java::Service::search", "method", 20, 60, "java"),
        sym("j", "Service.java", "Service.java::Service::getItem", "method", 8, 10, "java"),
        sym("j", "Mapper.java", "org.x.Mapper.getItem", "method", 3, 3, "java"),
      ],
    });
    expect(set.items.J![0]).toMatchObject({
      symbol: "Service.java::Service::getItem",
      afterLine: 8,
    });
  });

  it("skips a rename whose target already exists", () => {
    const set = generateStalenessPatchSet({
      corpus: "toy",
      items: [{ id: "I", expectedFiles: ["r:a.go", "r:b.go"] }],
      symbols: [
        sym("r", "a.go", "a.go::A", "function", 1, 5),
        sym("r", "b.go", "b.go::B", "function", 1, 5),
        sym("r", "b_renamed.go", "b_renamed.go::C", "function", 1, 5),
      ],
    });
    expect(set.items.I!.map((o) => o.op)).toEqual(["edit", "delete"]);
  });

  it("round-trips through parseStalenessPatchSet", () => {
    const set = generateStalenessPatchSet({
      corpus: "toy",
      items: [{ id: "I-1", expectedFiles: ["r:pkg/a.go", "r:pkg/b.go"] }],
      symbols,
    });
    expect(parseStalenessPatchSet(JSON.stringify(set))).toEqual(set);
  });
});

describe("commentLineFor", () => {
  it("writes the edit as a comment of the language", () => {
    expect(commentLineFor("go")).toBe("// metis-eval #1834: synthetic staleness edit");
    expect(commentLineFor("Python")).toBe("# metis-eval #1834: synthetic staleness edit");
    expect(commentLineFor("mybatis-xml")).toBe(
      "<!-- metis-eval #1834: synthetic staleness edit -->",
    );
    expect(commentLineFor("sql")).toBe("-- metis-eval #1834: synthetic staleness edit");
  });
});

describe("renamedPath and directoryDistance", () => {
  it("counts directories apart", () => {
    expect(directoryDistance("a/b", "a/b")).toBe(0);
    expect(directoryDistance("a/b/c", "a/b")).toBe(1);
    expect(directoryDistance("a/x", "a/b")).toBe(2);
    expect(directoryDistance(".", "a")).toBe(1);
  });

  it("inserts _renamed before the extension", () => {
    expect(renamedPath("a/b.go")).toBe("a/b_renamed.go");
    expect(renamedPath("Makefile")).toBe("Makefile_renamed");
  });
});

describe("parseStalenessPatchSet", () => {
  const valid = {
    corpus: "c",
    issue: STALENESS_ISSUE,
    rule: "r",
    items: { I: [{ op: "delete", repo: "r", file: "a.go" }] },
  };
  const parse = (v: unknown) => () => parseStalenessPatchSet(JSON.stringify(v));

  it("refuses an unsafe path, a set for another issue and a malformed op", () => {
    expect(parse(valid)).not.toThrow();
    for (const file of ["../x.go", "/etc/passwd", "a/../../b", "a\\b", "-rf", "a//b", "./a"]) {
      expect(parse({ ...valid, items: { I: [{ op: "delete", repo: "r", file }] } })).toThrow(
        /not a safe repository path/,
      );
    }
    expect(parse({ ...valid, issue: 1 })).toThrow(/issue 1/);
    expect(parse({ ...valid, corpus: 3 })).toThrow(/no corpus/);
    expect(parse({ ...valid, rule: 3 })).toThrow(/no rule/);
    expect(parse({ ...valid, items: [] })).toThrow(/no items/);
    expect(parse({ ...valid, items: { I: [] } })).toThrow(/no operations/);
    expect(parse({ ...valid, items: { I: [{ op: "move", repo: "r", file: "a" }] } })).toThrow(
      /unknown op/,
    );
    expect(parse({ ...valid, items: { I: [{ op: "delete", repo: "R!", file: "a" }] } })).toThrow(
      /no repo/,
    );
    expect(
      parse({ ...valid, items: { I: [{ op: "rename", repo: "r", from: "a", to: "a" }] } }),
    ).toThrow(/rename to itself/);
    const edit = { op: "edit", repo: "r", file: "a.go", symbol: "S", afterLine: 1, text: "// x" };
    expect(parse({ ...valid, items: { I: [edit] } })).not.toThrow();
    expect(parse({ ...valid, items: { I: [{ ...edit, symbol: "" }] } })).toThrow(/no symbol/);
    expect(parse({ ...valid, items: { I: [{ ...edit, afterLine: 0 }] } })).toThrow(/afterLine/);
    expect(parse({ ...valid, items: { I: [{ ...edit, text: "a\nb" }] } })).toThrow(
      /one non-empty line/,
    );
    expect(parseStalenessPatchSet.bind(null, "null")).toThrow(/not an object/);
  });

  it("refuses two operations on one file", () => {
    expect(
      parse({
        ...valid,
        items: {
          I: [
            { op: "rename", repo: "r", from: "a.go", to: "b.go" },
            { op: "delete", repo: "r", file: "b.go" },
          ],
        },
      }),
    ).toThrow(/r:b.go is touched twice/);
    const edit = (afterLine: number) => ({
      op: "edit",
      repo: "r",
      file: "a.go",
      symbol: `S${afterLine}`,
      afterLine,
      text: "// x",
    });
    // Several edits of one file are one change; a rename or delete of it is not.
    expect(parse({ ...valid, items: { I: [edit(1), edit(5)] } })).not.toThrow();
    expect(parse({ ...valid, items: { I: [edit(5), edit(5)] } })).toThrow(
      /two edits after line 5 of r:a.go/,
    );
    expect(
      parse({ ...valid, items: { I: [edit(1), { op: "delete", repo: "r", file: "a.go" }] } }),
    ).toThrow(/r:a.go is touched twice/);
    expect(
      parse({ ...valid, items: { I: [{ op: "delete", repo: "r", file: "a.go" }, edit(1)] } }),
    ).toThrow(/r:a.go is touched twice/);
  });
});

describe("stalenessPatchProblems", () => {
  it("names a missing item, a file outside the graph, an existing rename target, a wrong line and an extra item", () => {
    const set = parseStalenessPatchSet(
      JSON.stringify({
        corpus: "toy",
        issue: STALENESS_ISSUE,
        rule: "r",
        items: {
          A: [
            {
              op: "edit",
              repo: "r",
              file: "pkg/a.go",
              symbol: "pkg/a.go::Long",
              afterLine: 30,
              text: "// x",
            },
            { op: "rename", repo: "r", from: "pkg/gone.go", to: "pkg/near.go" },
            { op: "delete", repo: "r", file: "pkg/missing.go" },
          ],
          B: [
            {
              op: "edit",
              repo: "r",
              file: "pkg/a.go",
              symbol: "pkg/a.go::Nope",
              afterLine: 1,
              text: "// x",
            },
          ],
          EXTRA: [{ op: "delete", repo: "r", file: "pkg/near.go" }],
        },
      }),
    );
    expect(
      stalenessPatchProblems(set, { name: "other", itemIds: ["A", "B", "C"], symbols }),
    ).toEqual([
      "the patch set is for toy, not other",
      "A: line 30 is not inside pkg/a.go::Long (10-30)",
      "A: r:pkg/gone.go is not in the graph",
      "A: r:pkg/near.go already exists",
      "A: r:pkg/missing.go is not in the graph",
      "B: no symbol pkg/a.go::Nope in r:pkg/a.go",
      "C: no staleness patch",
      "EXTRA: not an item of other",
    ]);
  });

  it("finds nothing wrong with a generated set", () => {
    const items = [{ id: "I-1", expectedFiles: ["r:pkg/a.go", "r:pkg/b.go"] }];
    const set = generateStalenessPatchSet({ corpus: "toy", items, symbols });
    expect(stalenessPatchProblems(set, { name: "toy", itemIds: ["I-1"], symbols })).toEqual([]);
  });
});

const ops: StalenessOp[] = [
  { op: "edit", repo: "r", file: "e.go", symbol: "S", afterLine: 1, text: "// x" },
  { op: "rename", repo: "r", from: "old.go", to: "new.go" },
  { op: "delete", repo: "r", file: "del.go" },
];

describe("the patched views", () => {
  it("patchedFileSymbols reads a renamed file at its new path and nothing at the old one or a deleted one", async () => {
    const base = vi.fn(async (paths: string[], repo: string) =>
      paths.map((filePath) => ({
        id: `${repo}:${filePath}`,
        qualifiedName: `${filePath}::x`,
        filePath,
        kind: "function",
        language: "go",
        startLine: 1,
        endLine: 2,
        signature: null,
      })),
    );
    const view = patchedFileSymbols(base, ops);
    const rows = await view(["new.go", "old.go", "del.go", "e.go"], "r");
    expect(rows.map((r) => [r.id, r.filePath])).toEqual([
      ["r:old.go", "new.go"],
      ["r:e.go", "e.go"],
    ]);
    expect(base).toHaveBeenCalledWith(["old.go", "e.go"], "r");
    // Another repository is not patched; nothing asked, nothing read.
    expect((await view(["old.go"], "s")).map((r) => r.filePath)).toEqual(["old.go"]);
    base.mockClear();
    expect(await view(["del.go"], "r")).toEqual([]);
    expect(base).not.toHaveBeenCalled();
  });

  it("unrenamedFiles scores a renamed file as the file it was, keeping order and dropping the duplicate", () => {
    expect(unrenamedFiles(["r:new.go", "r:a.go", "r:old.go", "s:new.go"], ops)).toEqual([
      "r:old.go",
      "r:a.go",
      "s:new.go",
    ]);
  });

  it("patchedGraphFiles moves the renamed file and drops the deleted one", () => {
    expect([...patchedGraphFiles(new Set(["r:old.go", "r:del.go", "r:e.go"]), ops)].sort()).toEqual(
      ["r:e.go", "r:new.go"],
    );
  });
});

describe("the patched corpus a staleness arm searches", () => {
  const row = (filePath: string, n: string) => ({
    id: `r#${n}`,
    repo: "r",
    name: n,
    qualifiedName: `${filePath}::${n}`,
    kind: "function",
    language: "go",
    filePath,
    startLine: 1,
    endLine: 3,
    embeddingText: `function ${n} in ${filePath}`,
  });

  it("patchedSymbolRows moves a renamed file's rows to the new path and drops a deleted file's", () => {
    const rows = [
      row("old.go", "o"),
      row("del.go", "d"),
      row("e.go", "e"),
      { ...row("x.go", "x"), repo: "s" },
    ];
    const out = patchedSymbolRows(rows, ops);
    expect(out.map((r) => [r.repo, r.filePath, r.qualifiedName, r.embeddingText])).toEqual([
      ["r", "new.go", "new.go::o", "function o in new.go"],
      ["r", "e.go", "e.go::e", "function e in e.go"],
      ["s", "x.go", "x.go::x", "function x in x.go"],
    ]);
    // The same row object when untouched; the id is kept.
    expect(out[1]).toBe(rows[2]);
    expect(out[0]!.id).toBe("r#o");
    const { embeddingText: _none, ...bare } = row("old.go", "b");
    expect(patchedSymbolRows([bare], ops)[0]).not.toHaveProperty("embeddingText");
  });

  it("searchWithoutFiles drops the gone files' hits and rows, and is the same search when none are gone", async () => {
    const search: { searcher: SeedSearcher; loadSymbols: SeedSymbolLoader } = {
      searcher: {
        search: async () => [
          { symbolId: "1", filePath: "a.java", name: "a", kind: "method", score: 1 },
          { symbolId: "2", filePath: "gone.java", name: "g", kind: "method", score: 0.5 },
        ],
      },
      loadSymbols: async (ids) =>
        ids.map((id) => ({
          id,
          qualifiedName: id,
          filePath: id === "2" ? "gone.java" : "a.java",
          kind: "method",
          language: "java",
          startLine: 1,
          endLine: 2,
          signature: null,
        })),
    };
    expect(searchWithoutFiles(search, new Set())).toBe(search);
    const without = searchWithoutFiles(search, new Set(["gone.java"]));
    expect((await without.searcher.search("q", "p")).map((h) => h.symbolId)).toEqual(["1"]);
    expect((await without.loadSymbols(["1", "2"], "p")).map((r) => r.id)).toEqual(["1"]);
  });
});

describe("withoutFreshness and tallyFreshness", () => {
  const row = (freshness?: string): StoredLinkRow => ({
    codeSymbolId: null,
    filePath: "a.go",
    startLine: null,
    endLine: null,
    confidence: 0.5,
    source: "analysis-grounding",
    ...(freshness ? { freshness } : {}),
  });

  it("hides the freshness and keeps everything else", async () => {
    const load = vi.fn(async () => [row("stale"), row("fresh")]);
    const out = await withoutFreshness(load)("req", "proj");
    expect(load).toHaveBeenCalledWith("req", "proj");
    expect(out).toEqual([row(), row()]);
    expect(out.every((l) => !("freshness" in l))).toBe(true);
  });

  it("counts each state; a row with none is unverified", () => {
    const t = emptyTally();
    tallyFreshness(
      [row("fresh"), row("moved"), row("stale"), row("stale"), row("unverified"), row()],
      t,
    );
    expect(t).toEqual({ fresh: 1, moved: 1, stale: 2, unverified: 2 });
  });
});

/** An in-memory clone. */
function memFiles(initial: Record<string, string>): CloneFiles & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (p) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    writeFile: async (p, t) => void files.set(p, t),
    rename: async (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    remove: async (p) => void files.delete(p),
    exists: async (p) => files.has(p),
    mkdirp: async () => undefined,
  };
}

describe("applyOpsToClone", () => {
  const root = "/clones/c";

  it("inserts the line after the given line, keeping CRLF, then renames, then deletes", async () => {
    const fsx = memFiles({
      "/clones/c/e.go": "func A() {\r\n\treturn\r\n}\r\n",
      "/clones/c/old.go": "package x\n",
      "/clones/c/del.go": "package y\n",
    });
    await applyOpsToClone(root, [...ops].reverse(), fsx);
    expect(fsx.files.get("/clones/c/e.go")).toBe("func A() {\r\n// x\r\n\treturn\r\n}\r\n");
    expect(fsx.files.get("/clones/c/new.go")).toBe("package x\n");
    expect(fsx.files.has("/clones/c/old.go")).toBe(false);
    expect(fsx.files.has("/clones/c/del.go")).toBe(false);
  });

  it("applies several edits of one file bottom-up, so each lands after its own line", async () => {
    const fsx = memFiles({ "/clones/c/e.go": "f1 {\n}\nf2 {\n}\n" });
    const at = (afterLine: number): StalenessOp => ({
      op: "edit",
      repo: "r",
      file: "e.go",
      symbol: `f${afterLine}`,
      afterLine,
      text: `// ${afterLine}`,
    });
    await applyOpsToClone(root, [at(1), at(3)], fsx);
    expect(fsx.files.get("/clones/c/e.go")).toBe("f1 {\n// 1\n}\nf2 {\n// 3\n}\n");
  });

  it("fails loudly on a patch that no longer fits the clone", async () => {
    const edit = ops[0] as Extract<StalenessOp, { op: "edit" }>;
    await expect(
      applyOpsToClone(root, [{ ...edit, afterLine: 9 }], memFiles({ "/clones/c/e.go": "a\nb" })),
    ).rejects.toThrow(/has 2 lines; cannot edit after line 9/);
    await expect(applyOpsToClone(root, [ops[1]!], memFiles({}))).rejects.toThrow(
      /cannot rename old.go: not in the clone/,
    );
    await expect(
      applyOpsToClone(
        root,
        [ops[1]!],
        memFiles({ "/clones/c/old.go": "", "/clones/c/new.go": "" }),
      ),
    ).rejects.toThrow(/cannot rename to new.go: it exists/);
    await expect(applyOpsToClone(root, [ops[2]!], memFiles({}))).rejects.toThrow(
      /cannot delete del.go: not in the clone/,
    );
  });

  it("resolveInClone refuses a path that escapes the clone", () => {
    expect(resolveInClone(root, "a/b.go")).toBe("/clones/c/a/b.go");
    expect(() => resolveInClone(root, "../x")).toThrow(/not a safe repository path/);
    expect(() => assertSafeRepoPath(42)).toThrow(/not a safe repository path/);
  });

  it("works on the real file system", async () => {
    const { mkdtemp, readFile, writeFile, readdir, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "staleness-"));
    try {
      await writeFile(path.join(dir, "e.go"), "a\nb\n");
      await writeFile(path.join(dir, "old.go"), "o\n");
      await writeFile(path.join(dir, "del.go"), "d\n");
      await applyOpsToClone(dir, ops);
      expect(await readFile(path.join(dir, "e.go"), "utf8")).toBe("a\n// x\nb\n");
      expect((await readdir(dir)).sort()).toEqual(["e.go", "new.go"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("withStalePatch", () => {
  function deps(fail?: "apply" | "read") {
    const calls: string[] = [];
    return {
      calls,
      cycle: {
        applyAndCommit: vi.fn(async (repo: string, o: readonly StalenessOp[]) => {
          calls.push(`apply ${repo} ${o.map((x) => x.op).join(",")}`);
          if (fail === "apply" && repo === "s") throw new Error("apply failed");
          return `patched-${repo}`;
        }),
        restore: vi.fn(async (repo: string) => void calls.push(`restore ${repo}`)),
        reingest: vi.fn(
          async (repo: string, sha: string) => void calls.push(`ingest ${repo} ${sha}`),
        ),
        pinnedSha: (repo: string) => `pin-${repo}`,
        afterRestore: vi.fn(async (repo: string) => void calls.push(`embed ${repo}`)),
      },
    };
  }
  const twoRepos: StalenessOp[] = [...ops, { op: "delete", repo: "s", file: "z.go" }];

  it("patches and re-ingests each touched repository, reads, then restores and re-ingests at the pin", async () => {
    const d = deps();
    const out = await withStalePatch(
      twoRepos,
      (n) => n,
      d.cycle,
      async () => {
        d.calls.push("read");
        return 7;
      },
    );
    expect(out).toBe(7);
    expect(d.calls).toEqual([
      "apply r edit,rename,delete",
      "ingest r patched-r",
      "apply s delete",
      "ingest s patched-s",
      "read",
      "restore r",
      "ingest r pin-r",
      "embed r",
      "restore s",
      "ingest s pin-s",
      "embed s",
    ]);
  });

  it("#1899 — restores every repository when one restore fails, and rethrows the read's error with it attached", async () => {
    const d = deps();
    d.cycle.restore.mockImplementation(async (repo: string) => {
      d.calls.push(`restore ${repo}`);
      if (repo === "r") throw new Error("git reset failed in r");
    });
    const readError = new Error("read failed");
    const rejected = withStalePatch(
      twoRepos,
      (n) => n,
      d.cycle,
      async () => {
        throw readError;
      },
    );
    await expect(rejected).rejects.toBe(readError);
    // s is still restored, re-ingested and embedded after r's restore threw.
    expect(d.calls.slice(-4)).toEqual(["restore r", "restore s", "ingest s pin-s", "embed s"]);
    const attached = (
      readError as Error & { restoreFailures?: Array<{ repo: string; error: Error }> }
    ).restoreFailures;
    expect(attached?.map((f) => [f.repo, f.error.message])).toEqual([
      ["r", "git reset failed in r"],
    ]);
  });

  it("#1899 — a read that succeeds still fails when a restore did, naming every failure", async () => {
    const d = deps();
    d.cycle.reingest.mockImplementation(async (repo: string, sha: string) => {
      d.calls.push(`ingest ${repo} ${sha}`);
      if (sha.startsWith("pin-")) throw new Error(`re-ingest of ${repo} failed`);
    });
    const err = await withStalePatch(
      twoRepos,
      (n) => n,
      d.cycle,
      async () => 7,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StalenessRestoreError);
    expect((err as Error).message).toBe(
      "restoring 2 repositories after the staleness patch failed: re-ingest of r failed; re-ingest of s failed",
    );
    expect((err as StalenessRestoreError<string>).restoreFailures.map((f) => f.repo)).toEqual([
      "r",
      "s",
    ]);
    // Neither re-embed ran: each repository's restore stopped at its failed re-ingest.
    expect(d.calls.filter((c) => c.startsWith("embed"))).toEqual([]);
  });

  it("#1925 — warns with the restore failures when the read threw a primitive they cannot ride on", async () => {
    const d = deps();
    d.cycle.restore.mockImplementation(async (repo: string) => {
      if (repo === "r") throw new Error("git reset failed in r");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        withStalePatch(
          twoRepos,
          (n) => n,
          d.cycle,
          async () => {
            throw "read failed";
          },
        ),
      ).rejects.toBe("read failed");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toBe(
        "restoring 1 repository after the staleness patch failed: git reset failed in r",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("#1925 — withNoopReingest refuses an empty repository list rather than read as if re-ingested", async () => {
    const d = deps();
    const read = vi.fn(async () => 3);
    await expect(withNoopReingest([], d.cycle, read)).rejects.toThrow(/no repository to re-ingest/);
    expect(read).not.toHaveBeenCalled();
  });

  it("#1899 — withNoopReingest re-ingests every repository at its pin, patches nothing, then reads", async () => {
    const d = deps();
    const out = await withNoopReingest(["r", "s"], d.cycle, async () => {
      d.calls.push("read");
      return 3;
    });
    expect(out).toBe(3);
    expect(d.calls).toEqual(["ingest r pin-r", "ingest s pin-s", "read"]);
    expect(d.cycle.applyAndCommit).not.toHaveBeenCalled();
    expect(d.cycle.restore).not.toHaveBeenCalled();
  });

  it("restores when the read fails, and every repository touched when a patch fails", async () => {
    const d = deps();
    await expect(
      withStalePatch(
        ops,
        (n) => n,
        d.cycle,
        async () => {
          throw new Error("read failed");
        },
      ),
    ).rejects.toThrow(/read failed/);
    expect(d.calls.slice(-3)).toEqual(["restore r", "ingest r pin-r", "embed r"]);

    const f = deps("apply");
    await expect(
      withStalePatch(
        twoRepos,
        (n) => n,
        f.cycle,
        async () => 1,
      ),
    ).rejects.toThrow(/apply failed/);
    expect(f.calls).toEqual([
      "apply r edit,rename,delete",
      "ingest r patched-r",
      "apply s delete",
      "restore r",
      "ingest r pin-r",
      "embed r",
      "restore s",
      "ingest s pin-s",
      "embed s",
    ]);
  });
});
