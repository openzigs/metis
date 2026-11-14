import { describe, expect, it } from "vitest";
import { citesFile, extractCitations, type CitableProduct } from "./citations.js";

const server: CitableProduct = {
  name: "miniflux",
  files: [
    "README.md",
    "miniflux.1",
    "internal/model/feed.go",
    "internal/storage/feed.go",
    "internal/api/middleware.go",
  ],
  documents: new Map([
    ["miniflux.1.txt", "miniflux.1"],
    ["FRD-12.md", "FRD-12.md"],
  ]),
};
const client: CitableProduct = {
  name: "python-client",
  files: ["README.md", "miniflux.py"],
  documents: new Map([["FRD-12.md", "FRD-12.md"]]),
};

describe("extractCitations", () => {
  it("reads exact paths with each line-reference shape", () => {
    const { citations } = extractCitations(
      [
        "See `internal/model/feed.go:123-150`,",
        "internal/api/middleware.go#L37-L66,",
        "`internal/storage/feed.go` (lines 100–111)",
        "and miniflux.py line 171.",
      ].join(" "),
      [server, client],
    );
    expect(citations).toEqual([
      { path: "internal/api/middleware.go", products: ["miniflux"], lines: [37, 66] },
      { path: "internal/model/feed.go", products: ["miniflux"], lines: [123, 150] },
      { path: "internal/storage/feed.go", products: ["miniflux"], lines: [100, 111] },
      { path: "miniflux.py", products: ["python-client"], lines: [171, 171] },
    ]);
  });

  it("resolves a unique suffix, a product prefix, a connector filename and an upload name", () => {
    const { citations } = extractCitations(
      "model/feed.go, miniflux/internal/api/middleware.go, connector:repo:eval-x:internal/storage/feed.go:5 and miniflux.1.txt",
      [server],
    );
    expect(citations.map((c) => [c.path, c.lines])).toEqual([
      ["internal/api/middleware.go", null],
      ["internal/model/feed.go", null],
      ["internal/storage/feed.go", [5, 5]],
      ["miniflux.1", null],
    ]);
  });

  it("counts a bare name that matches several files as ambiguous, not a citation", () => {
    const out = extractCitations("the logic is in feed.go", [server]);
    expect(out.citations).toEqual([]);
    expect(out.ambiguous).toEqual(["feed.go"]);
  });

  it("names every product holding a shared path, and drops a token naming different files", () => {
    const out = extractCitations("FRD-12.md and README.md", [server, client]);
    expect(out.citations).toEqual([
      { path: "FRD-12.md", products: ["miniflux", "python-client"], lines: null },
      { path: "README.md", products: ["miniflux", "python-client"], lines: null },
    ]);
    const split = extractCitations("x/feed.go", [
      { name: "a", files: ["x/feed.go"], documents: new Map() },
      { name: "b", files: ["y/x/feed.go"], documents: new Map() },
    ]);
    expect(split.citations).toEqual([]);
    expect(split.ambiguous).toEqual(["x/feed.go"]);
  });

  it("ignores tokens that name no file, dedupes repeats and orders a reversed range", () => {
    const out = extractCitations(
      "miniflux.app v2.3.3 at internal/model/feed.go:150-123 and internal/model/feed.go:150-123",
      [server],
    );
    expect(out.citations).toEqual([
      { path: "internal/model/feed.go", products: ["miniflux"], lines: [123, 150] },
    ]);
    expect(out.ambiguous).toEqual([]);
  });

  it("only resolves against the products in scope", () => {
    expect(extractCitations("miniflux.py:10", [server]).citations).toEqual([]);
  });

  it("still finds a citation after a word, a bracket or a colon", () => {
    const { citations } = extractCitations(
      "In (internal/model/feed.go:12) and at:miniflux.py, `README.md`",
      [server, client],
    );
    expect(citations.map((c) => c.path)).toEqual([
      "internal/model/feed.go",
      "README.md",
      "miniflux.py",
    ]);
  });

  // #2290 — the pattern starts a match only where a path can start, so a long
  // run of path characters is scanned once: the same pattern without that
  // took 48 s on 200,000 characters in #2242.
  it.each(["a", "a-", "a.", "a/", "a-a."])("scans a long run of %s in linear time", (unit) => {
    const run = unit.repeat(Math.ceil(200_000 / unit.length));
    const t0 = performance.now();
    extractCitations(run, [server, client]);
    // Quadratic takes seconds at this size; linear takes milliseconds. Wide on purpose.
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("citesFile", () => {
  it("matches path and product together", () => {
    const c = { path: "FRD-12.md", products: ["miniflux", "python-client"], lines: null };
    expect(citesFile(c, "python-client", "FRD-12.md")).toBe(true);
    expect(citesFile(c, "other", "FRD-12.md")).toBe(false);
    expect(citesFile(c, "miniflux", "README.md")).toBe(false);
  });
});
