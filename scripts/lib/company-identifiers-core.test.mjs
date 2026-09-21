import { describe, expect, it } from "vitest";

import {
  MIN_COLLAPSED_LENGTH,
  collapse,
  formatReport,
  isClean,
  isTextPath,
  parseTerms,
  resolveTermSource,
  scanFiles,
  scanText,
  stripIntegrityBlobs,
  termsRequired,
  tokenize,
} from "./company-identifiers-core.mjs";

/*
 * Every word below is INVENTED. The real vocabulary is not in this repository — see the
 * core's header — so these tests cannot use it, and must not: a test that spelled a real
 * term, even by concatenation, would publish it. (The matcher is proven against the
 * concatenation trick below precisely because an earlier version of this file used it.)
 */
const LIST = ["# comment", "zorblax", "Quux Widget", "=qzx", "=frob nitz", "", "   "].join("\n");
const terms = parseTerms(LIST);

describe("parseTerms", () => {
  it("skips comments and blanks, and numbers terms from 1 in list order", () => {
    expect(terms.map((t) => t.ordinal)).toEqual([1, 2, 3, 4]);
  });

  it("uses collapsed mode for long terms and token mode for short or =-prefixed ones", () => {
    expect(terms.map((t) => t.mode)).toEqual(["collapsed", "collapsed", "token", "token"]);
    expect(parseTerms("abcd")[0].mode).toBe("token");
    expect(parseTerms("abcde")[0].mode).toBe("collapsed");
    expect("abcde".length).toBe(MIN_COLLAPSED_LENGTH);
  });

  it("drops a term with no alphanumerics instead of letting it match every line", () => {
    expect(parseTerms("---\n=  \n***")).toEqual([]);
  });

  it("strips a trailing comment from a term line", () => {
    expect(parseTerms("zorblax   # the big one")[0].collapsed).toBe("zorblax");
  });
});

describe("tokenize / collapse", () => {
  it("splits on separators and camelCase joins", () => {
    expect(tokenize("fooBar_baz-QUX HTTPServer v2")).toEqual([
      "foo",
      "bar",
      "baz",
      "qux",
      "http",
      "server",
      "v2",
    ]);
  });

  it("collapses to lowercase alphanumerics", () => {
    expect(collapse("Foo_Bar-9.Baz")).toBe("foobar9baz");
  });
});

describe("scanText — collapsed terms", () => {
  it.each([
    ["lowercase", "see zorblax here"],
    ["uppercase", "SEE ZORBLAX HERE"],
    ["inside a package path", "import com.zorblax.client.Foo;"],
    ["inside an identifier", "const x = new ZorblaxClient();"],
    ["joined by an underscore", "user_zorblax_admin"],
  ])("finds a single-word term %s", (_name, line) => {
    expect(scanText(line, "f.ts", terms)).toEqual([{ file: "f.ts", line: 1, ordinal: 1 }]);
  });

  it.each([
    ["spaced", "the Quux Widget service"],
    ["snake", "QUUX_WIDGET_TABLE"],
    ["kebab", "quux-widget"],
    ["camel", "QuuxWidgetFactory"],
    ["run together", "quuxwidget"],
  ])("finds a two-word term written %s", (_name, line) => {
    expect(scanText(line, "f.ts", terms).map((h) => h.ordinal)).toEqual([2]);
  });

  it("finds a term assembled by string concatenation on one line", () => {
    // The trick the previous version of THIS test file used to hide a real word.
    expect(scanText('const B = "zor" + "blax";', "f.ts", terms).map((h) => h.ordinal)).toEqual([1]);
  });
});

describe("scanText — token terms", () => {
  it.each([
    ["bare", "the qzx job"],
    ["uppercase", "QZX"],
    ["snake neighbour", "qzx_loader"],
    ["camel neighbour", "QzxLoader"],
    ["in a path", "sas/etl/qzx/load.sas"],
  ])("finds a short term %s", (_name, line) => {
    expect(scanText(line, "f.ts", terms).map((h) => h.ordinal)).toEqual([3]);
  });

  it("does NOT fire inside a longer word — the reason short terms are token-matched", () => {
    expect(scanText("aqzxb qzxs xqzx", "f.ts", terms)).toEqual([]);
  });

  it("requires the words of a multi-word token term to be consecutive and in order", () => {
    expect(scanText("frob_nitz", "f.ts", terms).map((h) => h.ordinal)).toEqual([4]);
    expect(scanText("nitz frob", "f.ts", terms)).toEqual([]);
    expect(scanText("frob the nitz", "f.ts", terms)).toEqual([]);
  });
});

describe("scanText — reporting", () => {
  it("reports the 1-based line of a hit after clean lines", () => {
    expect(scanText("a\nb\nzorblax", "f.ts", terms)).toEqual([
      { file: "f.ts", line: 3, ordinal: 1 },
    ]);
  });

  it("reports each distinct term on a line", () => {
    expect(scanText("zorblax and qzx", "f.ts", terms).map((h) => h.ordinal)).toEqual([1, 3]);
  });

  it("carries no matched text and no excerpt — the log may be public", () => {
    const [hit] = scanText("secret zorblax line", "f.ts", terms);
    expect(Object.keys(hit).sort()).toEqual(["file", "line", "ordinal"]);
    expect(JSON.stringify(hit)).not.toContain("zorblax");
  });

  it("returns nothing for clean text, and nothing at all for an empty list", () => {
    expect(scanText("perfectly ordinary", "f.ts", terms)).toEqual([]);
    expect(scanText("zorblax", "f.ts", [])).toEqual([]);
  });
});

describe("stripIntegrityBlobs", () => {
  const blob = `sha512-${"Aq/zx+QZX".repeat(9)}ab==`;

  it("removes a lockfile integrity hash so random base64 cannot match a short term", () => {
    const line = `resolution: {integrity: ${blob}}`;
    expect(tokenize(line)).toContain("qzx");
    expect(scanText(line, "pnpm-lock.yaml", terms)).toEqual([]);
  });

  it("still scans the REST of the same line", () => {
    expect(scanText(`qzx ${blob}`, "pnpm-lock.yaml", terms).map((h) => h.ordinal)).toEqual([3]);
  });

  it("does not strip a short or unprefixed run, so prose cannot hide behind it", () => {
    expect(stripIntegrityBlobs("sha512-qzx")).toBe("sha512-qzx");
    expect(scanText("sha512-qzx", "f.ts", terms).map((h) => h.ordinal)).toEqual([3]);
  });
});

describe("isTextPath", () => {
  it("rejects binary extensions and accepts prose and source", () => {
    expect(isTextPath("a/b.png")).toBe(false);
    expect(isTextPath("a/b.DOCX")).toBe(false);
    expect(isTextPath("a/b.ts")).toBe(true);
    expect(isTextPath("README.md")).toBe(true);
  });
});

describe("scanFiles", () => {
  /** @param {Record<string, string | null | Error>} tree */
  const reader = (tree) => (/** @type {string} */ file) => {
    const value = tree[file];
    if (value instanceof Error) throw value;
    return value;
  };

  it("collects offenders across files and records what it scanned", () => {
    const tree = { "a.ts": "zorblax", "b.md": "clean", "c.ts": "x\nqzx" };
    const result = scanFiles({ files: Object.keys(tree), readFile: reader(tree), terms });
    expect(result.scanned).toEqual(["a.ts", "b.md", "c.ts"]);
    expect(result.offenders).toEqual([
      { file: "a.ts", line: 1, ordinal: 1 },
      { file: "c.ts", line: 2, ordinal: 3 },
    ]);
    expect(isClean(result)).toBe(false);
  });

  it("scans a tracked eval-data path like any other — there is no exclusion list", () => {
    const tree = { "eval-data/corpus/x/docs/A.md": "zorblax" };
    const result = scanFiles({ files: Object.keys(tree), readFile: reader(tree), terms });
    expect(result.scanned).toEqual(["eval-data/corpus/x/docs/A.md"]);
    expect(isClean(result)).toBe(false);
  });

  it("exposes no exclusion knob for a caller to reintroduce one through", () => {
    const tree = { "eval-data/a.md": "zorblax" };
    const result = scanFiles(
      /** @type {any} */ ({
        files: Object.keys(tree),
        readFile: reader(tree),
        terms,
        exclude: ["eval-data/"],
        excludePrefixes: ["eval-data/"],
      }),
    );
    expect(result.offenders).toHaveLength(1);
  });

  it("flags a term in a PATH as line 0, including a binary file's name", () => {
    const tree = { "docs/zorblax/shot.png": "", "src/qzx/load.ts": "clean" };
    const result = scanFiles({ files: Object.keys(tree), readFile: reader(tree), terms });
    expect(result.skippedBinary).toEqual(["docs/zorblax/shot.png"]);
    expect(result.offenders).toEqual([
      { file: "docs/zorblax/shot.png", line: 0, ordinal: 1 },
      { file: "src/qzx/load.ts", line: 0, ordinal: 3 },
    ]);
  });

  it("does NOT read binary files", () => {
    const read = [];
    scanFiles({
      files: ["a.png", "b.ts"],
      readFile: (file) => (read.push(file), "clean"),
      terms,
    });
    expect(read).toEqual(["b.ts"]);
  });

  it("treats an unreadable file as a FAILURE, not as clean", () => {
    const tree = { "a.ts": new Error("EACCES") };
    const result = scanFiles({ files: ["a.ts"], readFile: reader(tree), terms });
    expect(result.unreadable).toEqual([{ file: "a.ts", message: "EACCES" }]);
    expect(result.scanned).toEqual([]);
    expect(isClean(result)).toBe(false);
  });

  it("distinguishes a tracked-but-absent path from an unreadable one", () => {
    const result = scanFiles({ files: ["gone.ts"], readFile: () => null, terms });
    expect(result.absent).toEqual(["gone.ts"]);
    expect(result.unreadable).toEqual([]);
    expect(isClean(result)).toBe(true);
  });

  it("is NOT clean against an empty term list — nothing checked is not nothing found", () => {
    const result = scanFiles({ files: ["a.ts"], readFile: () => "zorblax", terms: [] });
    expect(result.offenders).toEqual([]);
    expect(isClean(result)).toBe(false);
  });
});

describe("resolveTermSource", () => {
  const files = {
    "/repo/.private-terms": "from-repo",
    "/home/pt.txt": "from-home",
    "/x": "from-x",
  };
  const readOptional = (/** @type {string} */ file) => files[file] ?? null;
  const base = { readOptional, repoFile: "/repo/.private-terms", homeFile: "/home/pt.txt" };

  it("prefers the inline env list, then the env file, then the repo file, then home", () => {
    expect(
      resolveTermSource({
        ...base,
        env: { METIS_PRIVATE_TERMS: "inline", METIS_PRIVATE_TERMS_FILE: "/x" },
      })?.raw,
    ).toBe("inline");
    expect(resolveTermSource({ ...base, env: { METIS_PRIVATE_TERMS_FILE: "/x" } })?.raw).toBe(
      "from-x",
    );
    expect(resolveTermSource({ ...base, env: {} })?.raw).toBe("from-repo");
    expect(resolveTermSource({ ...base, env: {}, repoFile: "/nope" })?.raw).toBe("from-home");
  });

  it("treats a blank env value or an empty file as absent and keeps looking", () => {
    // An Actions secret that is not set arrives as "", not as undefined.
    expect(resolveTermSource({ ...base, env: { METIS_PRIVATE_TERMS: "  " } })?.raw).toBe(
      "from-repo",
    );
    const blank = (/** @type {string} */ file) => (file === "/repo/.private-terms" ? " \n" : null);
    expect(resolveTermSource({ ...base, env: {}, readOptional: blank })).toBeNull();
  });

  it("returns null when nothing is configured, and never names the home file it lacks", () => {
    expect(
      resolveTermSource({ env: {}, readOptional, repoFile: "/nope", homeFile: null }),
    ).toBeNull();
  });

  it("labels the source without echoing the list", () => {
    const resolved = resolveTermSource({ ...base, env: { METIS_PRIVATE_TERMS: "zorblax" } });
    expect(resolved?.source).toBe("env METIS_PRIVATE_TERMS");
  });
});

describe("termsRequired", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["", false],
    ["0", false],
    ["false", false],
    [undefined, false],
  ])("METIS_REQUIRE_PRIVATE_TERMS=%s → %s", (value, expected) => {
    expect(termsRequired({ METIS_REQUIRE_PRIVATE_TERMS: value })).toBe(expected);
  });
});

describe("formatReport", () => {
  const scan = (/** @type {Record<string, string>} */ tree, list = terms) =>
    scanFiles({ files: Object.keys(tree), readFile: (file) => tree[file], terms: list });

  it("prints file:line and the term ordinal — and NEVER the matched text", () => {
    const report = formatReport(
      scan({ "a.ts": "x\nthe zorblax line" }),
      "file .private-terms",
    ).join("\n");
    expect(report).toContain("a.ts:2  term #1");
    expect(report).not.toMatch(/zorblax/i);
    expect(report).not.toContain("the zorblax line");
  });

  it("marks a path hit as being in the PATH", () => {
    const report = formatReport(scan({ "qzx/a.ts": "clean" }), "env").join("\n");
    expect(report).toContain("(in the PATH)");
  });

  it("names every unreadable file and does NOT claim a clean scan", () => {
    const result = scanFiles({
      files: ["a.ts"],
      readFile: () => {
        throw new Error("EISDIR");
      },
      terms,
    });
    const report = formatReport(result, "env").join("\n");
    expect(report).toContain("a.ts  (EISDIR)");
    expect(report).not.toContain("none found");
  });

  it("says how many terms it checked and where they came from", () => {
    const report = formatReport(scan({ "a.ts": "clean" }), "file .private-terms").join("\n");
    expect(report).toContain("against 4 private terms (file .private-terms), none found");
  });

  it("says NOTHING WAS CHECKED for an empty list, never 'none found'", () => {
    const report = formatReport(scan({ "a.ts": "zorblax" }, []), "env").join("\n");
    expect(report).toContain("EMPTY");
    expect(report).not.toContain("none found");
  });

  it("reports tracked-but-absent paths", () => {
    const result = scanFiles({ files: ["gone.ts"], readFile: () => null, terms });
    expect(formatReport(result, "env").join("\n")).toContain("1 tracked path(s) not present");
  });
});
