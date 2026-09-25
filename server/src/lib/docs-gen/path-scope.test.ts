import { describe, expect, it } from "vitest";
import {
  MAX_PATH_PREFIXES,
  MAX_PATH_PREFIX_LENGTH,
  PathScopeEmptyError,
  isInPathScope,
  normalizePathPrefix,
  pathPrefixesSchema,
  pathScopeLabel,
  pathScopeWhere,
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

  it("handles a lone H1 and a document without one", () => {
    expect(withPathScopeBanner("# T", ["a"])).toMatch(/^# T\n\n> \*\*Scoped document/);
    expect(withPathScopeBanner("body", ["a"])).toMatch(/^> \*\*Scoped document[^\n]*\n\nbody$/);
  });
});
