/**
 * Issue #698 — `pnpm typecheck` must type-check the server's tests, not only src/.
 *
 * tsconfig.json excludes tests/ and co-located src tests so `build` emits only the
 * library; vitest transpiles without type-checking. tsconfig.test.json closes that gap,
 * and this test stops the wiring being dropped silently: the gap it closes produces no
 * failure of its own. Same shape as packages/shared/tests/typecheck-covers-tests.test.ts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const PKG_DIR = join(import.meta.dirname, "..");

function scripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  return pkg.scripts;
}

/** The files a tsconfig resolves to, parsed the way `tsc -p` parses it (extends included). */
function parsed(configName: string): ts.ParsedCommandLine {
  const path = join(PKG_DIR, configName);
  const { config, error } = ts.readConfigFile(path, ts.sys.readFile);
  if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(config, ts.sys, PKG_DIR, undefined, path);
}

const rel = (files: string[]) => files.map((f) => f.slice(PKG_DIR.length + 1));

/** Every TypeScript source under `dir`, as a package-relative POSIX path. */
function tsFilesUnder(dir: string): string[] {
  return (readdirSync(join(PKG_DIR, dir), { recursive: true }) as string[])
    .map((f) => `${dir}/${f.split("\\").join("/")}`)
    .filter((f) => /\.[cm]?tsx?$/.test(f));
}

describe("pnpm typecheck covers @metis/server tests (#698)", () => {
  it("the typecheck script runs the src-only pass, then tsconfig.test.json with a raised heap", () => {
    // Pinned exactly: a regex would also accept `... || true` or `...; tsc -p ...`,
    // either of which neuters the gate while the guard stays green.
    //  - The src-only pass stays: its `rootDir: "src"` rejects a src file importing from
    //    outside src/ (TS6059, which breaks `build`); the test config's `rootDir: ".."`
    //    cannot, so it is not a full superset.
    //  - The test config peaks at ~6.7 GB and OOMs at Node's default heap. `node --max-...`
    //    rather than a POSIX `NODE_OPTIONS=` prefix, so the script also runs on Windows.
    expect(scripts().typecheck).toBe(
      "tsc --noEmit -p tsconfig.json && node --max-old-space-size=8192 node_modules/typescript/bin/tsc -p tsconfig.test.json",
    );
  });

  it("tsconfig.test.json includes every test file, type-checks it, and emits nothing", () => {
    const cfg = parsed("tsconfig.test.json");
    expect(cfg.errors).toEqual([]);
    expect(cfg.options.noEmit).toBe(true);
    // `noCheck` skips semantic checking entirely, so the pass would succeed on any type
    // error while every other assertion here stayed green.
    expect(cfg.options.noCheck).toBeFalsy();
    const files = new Set(rel(cfg.fileNames));
    // Enumerated, so narrowing `include` cannot drop one silently: every file under
    // tests/ and every test co-located in src/.
    const testFiles = [
      ...tsFilesUnder("tests"),
      ...tsFilesUnder("src").filter((f) => /\.test\.ts$/.test(f)),
    ];
    expect(testFiles.length).toBeGreaterThan(1000);
    const missing = testFiles.filter((f) => !files.has(f));
    expect(missing).toEqual([]);
    expect(files).toContain("vitest.config.ts");
    expect(files).toContain("vitest.integration.config.ts");
    expect(files).toContain("src/index.ts");
  });

  it("tsconfig.json still compiles only src/ library code", () => {
    expect(scripts().build).toBe("tsc -p tsconfig.json");
    const cfg = parsed("tsconfig.json");
    expect(cfg.options.noCheck).toBeFalsy();
    // What the chained src-only pass enforces that tsconfig.test.json cannot.
    const posix = (p: string | undefined) => p?.split("\\").join("/");
    expect(posix(cfg.options.rootDir)).toBe(posix(join(PKG_DIR, "src")));
    const files = rel(cfg.fileNames);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.startsWith("src/") && !/\.test\.tsx?$/.test(f))).toBe(true);
  });
});
