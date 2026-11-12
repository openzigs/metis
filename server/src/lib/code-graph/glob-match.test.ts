/**
 * #2327 — the bounded glob matcher shared by the symbol filter and list_files.
 */
import { describe, expect, it } from "vitest";
import { compileGlob, matchRepoGlob } from "./glob-match.js";

describe("matchRepoGlob", () => {
  it.each([
    ["src/index.ts", "src/index.ts", true],
    ["src/index.ts", "src/*.ts", true],
    ["src/deep/index.ts", "src/*.ts", false],
    ["src/a/b/c.ts", "src/**", true],
    ["lib/util.ts", "src/**", false],
    // `**/` is zero or more whole directories.
    ["a.ts", "**/*.ts", true],
    ["src/a.ts", "src/**/a.ts", true],
    ["src/x/y/a.ts", "src/**/a.ts", true],
    ["src/xa.ts", "src/**/a.ts", false],
    // `**` not followed by `/` crosses directories.
    ["src/x/y.test.ts", "src/**.test.ts", true],
    // `?` is one character, never `/`.
    ["src/a1.ts", "src/a?.ts", true],
    ["src/a/.ts", "src/a?.ts", false],
    ["src/a.ts", "src/a?.ts", false],
    // Everything else is literal.
    ["src/[a].ts", "src/[a].ts", true],
    ["src/a.ts", "src/[a].ts", false],
    ["src/{a,b}.ts", "src/{a,b}.ts", true],
    ["srcXindex.ts", "src.index.ts", false],
    // The whole path must match, case-sensitively.
    ["src/index.tsx", "src/*.ts", false],
    ["SRC/index.ts", "src/*.ts", false],
    // `*` matches an empty run, and `***` is `**`.
    ["src/.ts", "src/*.ts", true],
    ["src/a/b.ts", "src/***", true],
  ])("%s against %s → %s", (filePath, glob, want) => {
    expect(matchRepoGlob(filePath, glob)).toBe(want);
  });

  it("matches a catastrophic-backtracking pattern within a bound", () => {
    // As a regular expression (`^[^/]*a[^/]*a…b$`) this backtracks
    // polynomially in the number of stars on a long run of `a`s.
    const glob = `${"*a".repeat(30)}*b`;
    const path = "a".repeat(4000);
    const match = compileGlob(glob);
    const started = performance.now();
    for (let i = 0; i < 20; i++) expect(match(path)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(match(`${"a".repeat(60)}b`)).toBe(true);
  });
});
