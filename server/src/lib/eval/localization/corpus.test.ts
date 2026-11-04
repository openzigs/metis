import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCALIZATION_CORPORA,
  classifyChangedFiles,
  codeShapedTokens,
  decodeSymbolsFile,
  fileKey,
  graphFilesOf,
  loadLocalizationCorpus,
  normalizeFilePath,
  parseSlurpedPages,
  repoOfFileKey,
  resolveLocalizationCorpusDir,
  resolveSymbolsPath,
  validateCorpus,
  type LocalizationCorpusManifest,
  type LocalizationItem,
  type LocalizationSymbolsFile,
} from "./corpus.js";

const REPO = { name: "app", url: "https://github.com/o/app", ref: "main", sha: "abc" };

function item(over: Partial<LocalizationItem> = {}): LocalizationItem {
  return {
    id: "I-1",
    title: "Let customers change their email",
    text: "A customer can change the email address we hold.",
    expectedFiles: ["app:src/a.ts"],
    expectedRepos: ["app"],
    source: { kind: "authored" },
    ...over,
  };
}

function manifest(over: Partial<LocalizationCorpusManifest> = {}): LocalizationCorpusManifest {
  return {
    id: "localization-02-fixture-portfolio",
    description: "test",
    purpose: "held-out",
    license: "CC0-1.0",
    repos: [REPO],
    symbols: "symbols.json.gz",
    annotation: {
      rewrittenBy: "a person",
      rewrittenAt: "2026-11-04",
      sawDiffsBeforeRewriting: false,
      procedure: "test",
      reviewedBy: null,
    },
    items: [item()],
    ...over,
  };
}

const GRAPH = new Set(["app:src/a.ts", "app:src/b.ts"]);

describe("file keys", () => {
  it("normalizes separators and leading ./ but keeps case", () => {
    expect(normalizeFilePath(" .\\src\\A.ts ")).toBe("src/A.ts");
    expect(normalizeFilePath("/src/a.ts")).toBe("src/a.ts");
    expect(fileKey("app", "./src/a.ts")).toBe("app:src/a.ts");
  });

  it("splits the repository off a key", () => {
    expect(repoOfFileKey("app:src/a.ts")).toBe("app");
    expect(repoOfFileKey("no-colon")).toBe("");
  });
});

describe("codeShapedTokens", () => {
  it("passes plain business language and product names", () => {
    expect(codeShapedTokens("Send an article to Karakeep or Google Reader.")).toEqual([]);
  });

  it.each([
    ["the `token` field", "backtick: `token`"],
    ["edit handler.go", "file name: handler.go"],
    ["see internal/ui", "path: internal/ui"],
    ["call refresh() again", "call: refresh()"],
    ["the firstCategory value", "camelCase: firstCategory"],
    ["the FirstCategory value", "PascalCase: FirstCategory"],
    ["the category_id field", "snake_case: category_id"],
  ])("flags %s", (text, expected) => {
    expect(codeShapedTokens(text)).toContain(expected);
  });

  it("lets a corpus declare a product name that looks like an identifier", () => {
    expect(codeShapedTokens("A YouTube link")).toEqual(["PascalCase: YouTube"]);
    expect(codeShapedTokens("A YouTube link", ["YouTube"])).toEqual([]);
  });
});

describe("validateCorpus", () => {
  it("accepts a sound corpus", () => {
    expect(validateCorpus(manifest(), GRAPH)).toEqual([]);
  });

  it("lists every problem at once", () => {
    const problems = validateCorpus(
      manifest({
        items: [
          item({ expectedFiles: ["app:src/missing.ts", "other:x.ts"], expectedRepos: ["app"] }),
          item({ title: " ", expectedFiles: [], expectedRepos: [] }),
          item({
            id: "I-2",
            text: "Rename the FirstCategory helper",
            expectedVerdict: "maybe" as never,
          }),
        ],
      }),
      GRAPH,
    );
    expect(problems).toEqual([
      "item I-1: app:src/missing.ts is not a file of the code graph (list it in excludedFiles)",
      "item I-1: other:x.ts names an unknown repo",
      "item I-1: expectedRepos app ≠ the files' app,other",
      "item I-1: duplicate id",
      "item I-1: empty title or text",
      "item I-1: no ground-truth file",
      "item I-2: unknown verdict maybe",
      "item I-2: code-shaped wording (PascalCase: FirstCategory)",
    ]);
  });

  it("rejects an empty corpus", () => {
    expect(validateCorpus(manifest({ items: [] }), GRAPH)).toEqual(["corpus has no items"]);
  });

  it("checks the wording of a held-out set only", () => {
    const leaky = item({ text: "Fix showFeedEntriesPage in feed_entries.go" });
    expect(validateCorpus(manifest({ items: [leaky] }), GRAPH)).toHaveLength(1);
    expect(validateCorpus(manifest({ purpose: "in-sample", items: [leaky] }), GRAPH)).toEqual([]);
  });
});

describe("classifyChangedFiles", () => {
  it("scores graph files and excludes the rest, each with its reason", () => {
    const graph = new Set(["app:internal/ui/feed.go", "app:internal/old.go"]);
    const out = classifyChangedFiles(
      "app",
      [
        { filename: "internal/ui/feed.go", status: "modified" },
        { filename: "internal/ui/feed.go", status: "modified" },
        { filename: "internal/ui/feed_test.go", status: "modified" },
        { filename: "docs/guide.md", status: "modified" },
        { filename: "internal/new.go", status: "added" },
        { filename: "internal/locale/en.json", status: "modified" },
        {
          filename: "internal/renamed.go",
          status: "renamed",
          previous_filename: "internal/old.go",
        },
      ],
      graph,
    );
    expect(out.expectedFiles).toEqual(["app:internal/old.go", "app:internal/ui/feed.go"]);
    expect(out.excludedFiles).toEqual([
      { file: "app:internal/ui/feed_test.go", reason: "test" },
      { file: "app:docs/guide.md", reason: "documentation" },
      { file: "app:internal/new.go", reason: "added-by-change" },
      { file: "app:internal/locale/en.json", reason: "not-in-code-graph" },
    ]);
  });
});

describe("loading", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function writeCorpus(m: LocalizationCorpusManifest, symbols: LocalizationSymbolsFile) {
    dir = await mkdtemp(path.join(tmpdir(), "loc-corpus-"));
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(m));
    await writeFile(path.join(dir, "symbols.json.gz"), gzipSync(JSON.stringify(symbols)));
    return dir;
  }

  const row = (filePath: string, repo = "app") => ({
    id: `${repo}#${filePath}`,
    repo,
    name: "f",
    qualifiedName: `${filePath}::f`,
    kind: "function",
    language: "ts",
    filePath,
    startLine: 1,
    endLine: 2,
  });

  it("loads a sound corpus and keeps only its repositories' rows", async () => {
    const d = await writeCorpus(manifest(), {
      note: "",
      repos: [REPO, { ...REPO, name: "elsewhere" }],
      rows: [row("src/a.ts"), row("src/z.ts", "elsewhere")],
    });
    const c = await loadLocalizationCorpus("localization-02-fixture-portfolio", d);
    expect(c.symbols).toHaveLength(1);
    expect([...c.graphFiles]).toEqual(["app:src/a.ts"]);
  });

  it("refuses a manifest whose id is not the corpus name", async () => {
    const d = await writeCorpus(manifest(), { note: "", repos: [REPO], rows: [row("src/a.ts")] });
    await expect(loadLocalizationCorpus("localization-01-miniflux-heldout", d)).rejects.toThrow(
      /manifest id is "localization-02-fixture-portfolio"/,
    );
  });

  it("refuses symbol rows from another snapshot", async () => {
    const d = await writeCorpus(manifest(), {
      note: "",
      repos: [{ ...REPO, sha: "other" }],
      rows: [row("src/a.ts")],
    });
    await expect(loadLocalizationCorpus("localization-02-fixture-portfolio", d)).rejects.toThrow(
      /no snapshot of app@abc/,
    );
  });

  it("refuses an unsound corpus, naming the problem", async () => {
    const d = await writeCorpus(manifest(), { note: "", repos: [REPO], rows: [row("src/b.ts")] });
    await expect(loadLocalizationCorpus("localization-02-fixture-portfolio", d)).rejects.toThrow(
      /app:src\/a.ts is not a file of the code graph/,
    );
  });

  it("refuses a symbols path that leaves the corpora root (#1770)", async () => {
    const d = await writeCorpus(
      { ...manifest(), symbols: "../../etc/symbols.json.gz" },
      { note: "", repos: [REPO], rows: [row("src/a.ts")] },
    );
    await expect(loadLocalizationCorpus("localization-02-fixture-portfolio", d)).rejects.toThrow(
      /symbols path "..\/..\/etc\/symbols.json.gz" leaves the corpora root/,
    );
  });

  it("rejects an unknown corpus name", () => {
    expect(() => resolveLocalizationCorpusDir("nope")).toThrow(/unknown localization corpus/);
  });

  // The committed corpora are data the whole epic is measured on: each must load clean.
  it.each(LOCALIZATION_CORPORA)("the committed corpus %s is sound", async (name) => {
    const c = await loadLocalizationCorpus(name);
    expect(c.manifest.items.length).toBeGreaterThan(0);
    for (const i of c.manifest.items) {
      for (const f of i.expectedFiles) expect(c.graphFiles.has(f)).toBe(true);
    }
  });

  it("holds the sizes the issue asks for, and keeps the in-sample PRs out of the held-out set", async () => {
    const miniflux = await loadLocalizationCorpus("localization-01-miniflux-heldout");
    const fixture = await loadLocalizationCorpus("localization-02-fixture-portfolio");
    const inSample = await loadLocalizationCorpus("localization-00-miniflux-run7-insample");
    expect(miniflux.manifest.items.length).toBe(25);
    expect(fixture.manifest.items.length).toBe(15);
    expect(inSample.manifest.purpose).toBe("in-sample");
    // #4497, #4513 and #4519 fixed run-7 issues; #4453 is a walkthrough reference set.
    const prs = miniflux.manifest.items.map((i) =>
      i.source.kind === "upstream-pr" ? i.source.pr : 0,
    );
    for (const pr of [4453, 4497, 4513, 4519]) expect(prs).not.toContain(pr);
    expect(miniflux.manifest.annotation.sawDiffsBeforeRewriting).toBe(false);
    expect(new Set(fixture.manifest.items.map((i) => i.expectedVerdict))).toEqual(
      new Set(["implemented", "partial", "gap"]),
    );
  });

  it("decodes the committed symbol rows", async () => {
    const dirOf = resolveLocalizationCorpusDir("localization-02-fixture-portfolio");
    const file = decodeSymbolsFile(await readFile(path.join(dirOf, "symbols.json.gz")));
    expect(graphFilesOf(file.rows).size).toBe(10);
  });
});

describe("resolveSymbolsPath (#1770)", () => {
  const m = (symbols: string) => ({ id: "localization-02-fixture-portfolio" as const, symbols });
  const dir = path.join("/data", "corpus", "localization-02-fixture-portfolio");

  it("resolves inside the corpus, or a sibling corpus under the same root", () => {
    expect(resolveSymbolsPath(dir, m("symbols.json.gz"))).toBe(path.join(dir, "symbols.json.gz"));
    expect(resolveSymbolsPath(dir, m("../localization-01-miniflux-heldout/symbols.json.gz"))).toBe(
      path.join("/data", "corpus", "localization-01-miniflux-heldout", "symbols.json.gz"),
    );
  });

  it.each(["../../secrets.gz", "/etc/passwd", ".."])("refuses %j", (symbols) => {
    expect(() => resolveSymbolsPath(dir, m(symbols))).toThrow(/leaves the corpora root/);
  });

  it("resolves the committed in-sample corpus's shared rows", () => {
    const d = resolveLocalizationCorpusDir("localization-00-miniflux-run7-insample");
    expect(resolveSymbolsPath(d, m("../localization-01-miniflux-heldout/symbols.json.gz"))).toMatch(
      /localization-01-miniflux-heldout[\\/]symbols\.json\.gz$/,
    );
  });
});

describe("parseSlurpedPages (#1770)", () => {
  it("flattens every page, including a page boundary inside a string the old regex split", () => {
    const pages = [[{ filename: "a.go", patch: "x ][ y" }], [{ filename: "b.go" }], []];
    expect(parseSlurpedPages<{ filename: string }>(JSON.stringify(pages))).toEqual([
      { filename: "a.go", patch: "x ][ y" },
      { filename: "b.go" },
    ]);
  });

  it.each(['{"message":"Not Found"}', "[1, 2]", '[[{"a":1}], {"b":2}]'])("refuses %s", (json) => {
    expect(() => parseSlurpedPages(json)).toThrow(/array of page arrays/);
  });
});
