/**
 * Issue #694 — `pnpm typecheck` must type-check tests/**, not only src/.
 *
 * tsconfig.json excludes tests/ so `build` emits only src/ to dist/; vitest transpiles
 * without type-checking. tsconfig.test.json closes that gap, and this test stops the
 * wiring being dropped silently: the gap it closes produces no failure of its own.
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

describe("pnpm typecheck covers embeddings-svc tests (#694)", () => {
  it("the typecheck script runs tsconfig.test.json", () => {
    // Pinned exactly: a regex would also accept `... || true` or `...; tsc -p ...`,
    // either of which neuters the gate while the guard stays green.
    expect(scripts().typecheck).toBe("tsc --noEmit -p tsconfig.json && tsc -p tsconfig.test.json");
  });

  it("tsconfig.test.json includes every test file and emits nothing", () => {
    const cfg = parsed("tsconfig.test.json");
    expect(cfg.errors).toEqual([]);
    expect(cfg.options.noEmit).toBe(true);
    const files = new Set(rel(cfg.fileNames));
    // Every .ts under tests/ (enumerated, so narrowing `include` cannot drop one silently).
    const testFiles = (readdirSync(join(PKG_DIR, "tests"), { recursive: true }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `tests/${f.split("\\").join("/")}`);
    expect(testFiles.length).toBeGreaterThan(10);
    for (const f of testFiles) expect(files, f).toContain(f);
    expect(files).toContain("src/app.ts");
  });

  it("build still compiles only src/ from tsconfig.json", () => {
    expect(scripts().build).toBe("tsc -p tsconfig.json");
    const files = rel(parsed("tsconfig.json").fileNames);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.startsWith("src/"))).toBe(true);
  });
});
