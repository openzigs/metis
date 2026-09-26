import { micromark } from "micromark";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PATH_PREFIXES,
  MAX_PATH_PREFIX_LENGTH,
  PathScopeEmptyError,
  isInPathScope,
  normalizePathPrefix,
  pathPrefixesSchema,
  pathScopeLabel,
  pathScopeWhere,
  probePathScope,
  PATH_SCOPE_PROBE_MAX_PAGES,
  PATH_SCOPE_PROBE_PAGE_SIZE,
  readStoredPathScope,
  restrictToPathScope,
  scopedDocumentTitle,
  withPathScopeBanner,
} from "./path-scope.js";

describe("normalizePathPrefix", () => {
  it.each([
    ["packages/fit/", "packages/fit"],
    ["packages/fit", "packages/fit"],
    ["./packages//fit/", "packages/fit"],
    ["packages\\fit\\src", "packages/fit/src"],
    ["  packages/fit/  ", "packages/fit"],
    ["packages/./fit", "packages/fit"],
    ["packages/fit/rules.ts", "packages/fit/rules.ts"],
  ])("accepts %j as %j", (raw, value) => {
    expect(normalizePathPrefix(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ["..", "'..'"],
    ["../etc", "'..'"],
    ["packages/../../etc", "'..'"],
    ["packages\\..\\..\\etc", "'..'"],
    ["/etc/passwd", "absolute"],
    ["\\\\server\\share", "absolute"],
    ["C:\\Windows", "absolute"],
    ["c:/x", "absolute"],
    ["~/secrets", "absolute"],
    ["packages/fit\u0000.ts", "NUL"],
    ["packages/\nfit", "NUL"],
    ["", "must name"],
    ["/", "absolute"],
    ["./", "must name"],
    ["   ", "must name"],
  ])("rejects %j", (raw, reason) => {
    const r = normalizePathPrefix(raw);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toContain(reason);
  });

  it("rejects an over-long prefix", () => {
    const r = normalizePathPrefix("a".repeat(MAX_PATH_PREFIX_LENGTH + 1));
    expect(r.ok).toBe(false);
  });
});

describe("pathPrefixesSchema", () => {
  it("normalises and de-duplicates, preserving order", () => {
    expect(
      pathPrefixesSchema.parse(["packages/fit/", "./packages/fit", "packages/domain"]),
    ).toEqual(["packages/fit", "packages/domain"]);
  });

  it("rejects an empty list, an over-long list and a bad element", () => {
    expect(pathPrefixesSchema.safeParse([]).success).toBe(false);
    expect(
      pathPrefixesSchema.safeParse(
        Array.from({ length: MAX_PATH_PREFIXES + 1 }, (_, i) => `p${i}/`),
      ).success,
    ).toBe(false);
    const bad = pathPrefixesSchema.safeParse(["packages/fit/", "../x"]);
    expect(bad.success).toBe(false);
    expect(bad.success ? "" : bad.error.issues[0].message).toContain("pathPrefixes[1]");
    expect(pathPrefixesSchema.safeParse("packages/fit/").success).toBe(false);
    expect(pathPrefixesSchema.safeParse([42]).success).toBe(false);
  });
});

describe("readStoredPathScope", () => {
  it("is null when no scope was stored", () => {
    expect(readStoredPathScope({ docType: "architecture" })).toBeNull();
  });
  it("returns the stored scope", () => {
    expect(readStoredPathScope({ pathPrefixes: ["packages/fit"] })).toEqual(["packages/fit"]);
  });
  it("throws on a corrupted scope rather than widening to the full project", () => {
    expect(() => readStoredPathScope({ pathPrefixes: ["../x"] })).toThrow(/invalid/);
    expect(() => readStoredPathScope({ pathPrefixes: [] })).toThrow(/invalid/);
  });
});

describe("isInPathScope", () => {
  const scope = ["packages/fit", "apps/web/src/rules.ts"];
  it("matches the prefix itself and paths below it", () => {
    expect(isInPathScope("packages/fit", scope)).toBe(true);
    expect(isInPathScope("packages/fit/src/a.ts", scope)).toBe(true);
    expect(isInPathScope("apps/web/src/rules.ts", scope)).toBe(true);
  });
  it("is segment-aware", () => {
    expect(isInPathScope("packages/fitness/a.ts", scope)).toBe(false);
    expect(isInPathScope("packages/fit.ts", scope)).toBe(false);
    expect(isInPathScope("apps/web/src/rules.tsx", scope)).toBe(false);
    expect(isInPathScope("packages", scope)).toBe(false);
  });
  it("normalises stored paths (backslashes, ./, leading slash)", () => {
    expect(isInPathScope("packages\\fit\\a.ts", scope)).toBe(true);
    expect(isInPathScope("./packages/fit/a.ts", scope)).toBe(true);
    expect(isInPathScope("/packages/fit/a.ts", scope)).toBe(true);
  });
});

describe("pathScopeWhere", () => {
  it("builds a segment-aware OR fragment", () => {
    expect(pathScopeWhere(["packages/fit"])).toEqual([
      { filePath: "packages/fit" },
      { filePath: { startsWith: "packages/fit/" } },
    ]);
  });
});

describe("probePathScope", () => {
  // Prisma 7.8 compiles `startsWith` to `LIKE (? || '%')` with no escaping of
  // `%`/`_` and (SQLite) ASCII-case-insensitive matching — measured against a
  // scratch SQLite DB: `pack_ges/` and `pack%/` both matched
  // `packages/fit/a.ts`. The DB result is therefore only a candidate set.
  const rows = (...paths: string[]) => paths.map((filePath, i) => ({ id: `s${i}`, filePath }));

  it("confirms a DB candidate with the exact, segment-aware matcher", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(rows("packages/fit/a.ts"));
    await expect(probePathScope(["packages/fit"], fetch)).resolves.toBe("match");
    expect(fetch).toHaveBeenCalledWith({ afterId: undefined, take: PATH_SCOPE_PROBE_PAGE_SIZE });
  });

  it.each([
    ["an underscore wildcard", "pack_ges/fit"],
    ["a percent wildcard", "pack%"],
    ["a case-only difference", "Packages/Fit"],
  ])("a LIKE false positive from %s is not a match", async (_label, prefix) => {
    const fetch = vi.fn().mockResolvedValueOnce(rows("packages/fit/a.ts")).mockResolvedValue([]);
    await expect(probePathScope([prefix], fetch)).resolves.toBe("none");
  });

  it("pages past false positives by id until a real match", async () => {
    const page1 = Array.from({ length: PATH_SCOPE_PROBE_PAGE_SIZE }, (_, i) => ({
      id: `a${String(i).padStart(4, "0")}`,
      filePath: "my-modules/x.ts",
    }));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(rows("my_modules/y.ts"));
    await expect(probePathScope(["my_modules"], fetch)).resolves.toBe("match");
    expect(fetch).toHaveBeenNthCalledWith(2, {
      afterId: page1[page1.length - 1].id,
      take: PATH_SCOPE_PROBE_PAGE_SIZE,
    });
  });

  it("a short page ends the scan with no match", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(rows("other/x.ts"));
    await expect(probePathScope(["packages/fit"], fetch)).resolves.toBe("none");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops at the page cap and reports unknown rather than a false empty", async () => {
    const full = Array.from({ length: PATH_SCOPE_PROBE_PAGE_SIZE }, (_, i) => ({
      id: `b${i}`,
      filePath: "packagesXfit/x.ts",
    }));
    const fetch = vi.fn().mockResolvedValue(full);
    await expect(probePathScope(["packages_fit"], fetch)).resolves.toBe("unknown");
    expect(fetch).toHaveBeenCalledTimes(PATH_SCOPE_PROBE_MAX_PAGES);
  });
});

describe("restrictToPathScope", () => {
  const sym = (filePath: string) => ({ filePath });
  const fixture = () => ({
    modules: [
      {
        dir: "packages/fit/src",
        syms: [sym("packages/fit/src/a.ts"), sym("packages/fit/src/b.ts")],
      },
      { dir: "packages/fitness", syms: [sym("packages/fitness/c.ts")] },
      { dir: "apps/web", syms: [sym("apps/web/d.ts")] },
      { dir: "packages/fit/sql", syms: [] },
      { dir: "db/sql", syms: [] },
    ],
    symbols: [
      sym("packages/fit/src/a.ts"),
      sym("packages/fit/src/a.ts"),
      sym("packages/fit/src/b.ts"),
      sym("packages/fitness/c.ts"),
      sym("apps/web/d.ts"),
    ],
    meta: { totalFiles: 4, totalSymbols: 5 },
  });

  it("keeps only in-scope modules, symbols and counts — in place", () => {
    const inputs = fixture();
    const modulesRef = inputs.modules;
    const summary = restrictToPathScope(["packages/fit"], inputs);
    expect(inputs.modules).toBe(modulesRef);
    expect(inputs.modules.map((m) => m.dir)).toEqual(["packages/fit/src", "packages/fit/sql"]);
    expect(inputs.symbols.map((s) => s.filePath)).toEqual([
      "packages/fit/src/a.ts",
      "packages/fit/src/a.ts",
      "packages/fit/src/b.ts",
    ]);
    expect(inputs.meta).toEqual({ totalFiles: 2, totalSymbols: 3 });
    expect(summary).toEqual({ modules: 2, files: 2, symbols: 3 });
  });

  it("drops the out-of-scope symbols of a module that straddles the scope", () => {
    const inputs = fixture();
    restrictToPathScope(["packages/fit/src/a.ts"], inputs);
    expect(inputs.modules).toHaveLength(1);
    expect(inputs.modules[0].syms.map((s) => s.filePath)).toEqual(["packages/fit/src/a.ts"]);
  });

  it("throws PathScopeEmptyError when nothing matches (never an empty doc)", () => {
    const inputs = fixture();
    expect(() => restrictToPathScope(["packages/nope"], inputs)).toThrow(PathScopeEmptyError);
    try {
      restrictToPathScope(["packages/nope"], inputs);
    } catch (err) {
      expect((err as PathScopeEmptyError).code).toBe("PATH_SCOPE_EMPTY");
      expect((err as Error).message).toContain("packages/nope");
    }
    // Inputs are untouched when the scope is empty.
    expect(inputs.modules).toHaveLength(5);
  });
});

describe("title and banner", () => {
  it("labels the scope", () => {
    expect(pathScopeLabel(["packages/fit", "packages/domain"])).toBe(
      "packages/fit/, packages/domain/",
    );
  });

  it("appends a visible scope suffix to the title", () => {
    expect(scopedDocumentTitle("BR", ["packages/fit"])).toBe("BR [scope: packages/fit/]");
  });

  it("keeps the suffix within 200 characters, shortening the title", () => {
    const t = scopedDocumentTitle("x".repeat(200), ["packages/fit"]);
    expect(t.length).toBeLessThanOrEqual(200);
    expect(t.endsWith(" [scope: packages/fit/]")).toBe(true);
    const many = scopedDocumentTitle(
      "BR",
      Array.from({ length: 20 }, (_, i) => `packages/some-long-package-name-${i}`),
    );
    expect(many).toBe("BR [scope: 20 paths]");
    expect(scopedDocumentTitle("BR", ["a".repeat(100)])).toBe("BR [scope: 1 path]");
  });

  it("inserts the banner under the H1", () => {
    const out = withPathScopeBanner("# Title\n\n> header\n\n## A\n", ["packages/fit"]);
    expect(out.startsWith("# Title\n\n> **Scoped document — not a full-project document.**")).toBe(
      true,
    );
    expect(out).toContain("`packages/fit/`");
    expect(out).toContain("\n\n> header");
  });

  // OWASP A03 — a prefix is user input written into markdown. A backtick in it
  // must not close the code span and let the rest render as markdown (an
  // external image beacon, a link) in every viewer's browser.
  it("keeps a prefix with backticks inside its code span (no markdown injection)", () => {
    const evil = "a` ![x](https://evil.example/b.png) [go](https://evil.example) `b";
    const html = micromark(withPathScopeBanner("# T\n", [evil]));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a ");
    expect(html).toContain(
      "<code>a` ![x](https://evil.example/b.png) [go](https://evil.example) `b/</code>",
    );
  });

  it("renders an ordinary prefix as a plain code span", () => {
    expect(micromark(withPathScopeBanner("# T\n", ["packages/fit"]))).toContain(
      "<code>packages/fit/</code>",
    );
    // A prefix that starts or ends with a backtick is padded so the span still parses.
    expect(micromark(withPathScopeBanner("# T\n", ["`x"]))).toContain("<code>`x/</code>");
  });

  it("handles a lone H1 and a document without one", () => {
    expect(withPathScopeBanner("# T", ["a"])).toMatch(/^# T\n\n> \*\*Scoped document/);
    expect(withPathScopeBanner("body", ["a"])).toMatch(/^> \*\*Scoped document[^\n]*\n\nbody$/);
  });
});
