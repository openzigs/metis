/**
 * Issue #692 — `supertest` is gone from this package and must stay gone.
 *
 * supertest calls `app.listen(0)`, a WILDCARD bind, then dials `127.0.0.1:<port>`; on
 * macOS another process can bind the more specific address and answer instead (the #689
 * flake). Every HTTP test here drives the app in process through `invoke()`
 * (tests/helpers/invoke-app.ts). The per-file `listen` guard catches a supertest call at
 * run time; this test stops the dependency itself creeping back, unowned.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PKG_DIR = join(import.meta.dirname, "..");

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? testFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("supertest is not a dependency of embeddings-svc (#692)", () => {
  it("is not declared in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declared = ["dependencies", "devDependencies"].flatMap((k) => Object.keys(pkg[k] ?? {}));
    expect(declared).not.toContain("supertest");
    expect(declared).not.toContain("@types/supertest");
  });

  it("is not imported by any test file", () => {
    const importers = testFiles(join(PKG_DIR, "tests")).filter((f) =>
      /from\s+["']supertest["']|require\(\s*["']supertest["']\s*\)/.test(readFileSync(f, "utf8")),
    );
    expect(importers).toEqual([]);
  });
});
