// @vitest-environment node
/**
 * #269 — UI dependency hygiene.
 *
 *  - The ui-kit is the only package that imports Radix, and it does so through
 *    the unified `radix-ui` package (shadcn's `new-york` style moved to it in
 *    Feb 2026: https://ui.shadcn.com/docs/changelog/2026-02-radix-ui), not
 *    seven separate `@radix-ui/react-*` packages.
 *  - `ui/` imports no Radix directly (everything goes through `@metis/ui-kit`),
 *    so it must not re-declare the Radix packages.
 *  - `ui/` ships `tw-animate-css`, which `ui/src/app/globals.css` imports so the
 *    ui-kit's `animate-in` classes compile (asserted on the compiled CSS in
 *    `ui/tests/tailwind-theme-variants.test.ts`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_KIT = path.resolve(dirname, "..");
const UI = path.resolve(dirname, "../../../ui");

type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function manifest(dir: string): Manifest {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Manifest;
}

function allDeps(m: Manifest): string[] {
  return [...Object.keys(m.dependencies ?? {}), ...Object.keys(m.devDependencies ?? {})];
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

describe("unified radix-ui package (#269)", () => {
  it("ui-kit depends on radix-ui and on no @radix-ui/* package", () => {
    const deps = allDeps(manifest(UI_KIT));
    expect(deps).toContain("radix-ui");
    expect(deps.filter((d) => d.startsWith("@radix-ui/"))).toEqual([]);
  });

  it("ui-kit source imports Radix only from radix-ui", () => {
    const offenders = sourceFiles(path.join(UI_KIT, "src")).filter((f) =>
      /from\s+["']@radix-ui\//.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("ui/ does not re-declare Radix packages it never imports", () => {
    const deps = allDeps(manifest(UI));
    expect(deps.filter((d) => d.startsWith("@radix-ui/") || d === "radix-ui")).toEqual([]);
  });
});

describe("tw-animate-css (#269)", () => {
  it("ui/ declares tw-animate-css and globals.css imports it", () => {
    expect(allDeps(manifest(UI))).toContain("tw-animate-css");
    const css = readFileSync(path.join(UI, "src/app/globals.css"), "utf8");
    expect(css).toMatch(/^@import\s+["']tw-animate-css["'];/m);
  });
});
