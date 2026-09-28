/**
 * #272 — the heavy viewers stay out of the page bundles.
 *
 * `mermaid`, `@xyflow/react`, `react-diff-viewer-continued` and the KaTeX
 * stylesheet were imported statically, so every page that could show markdown
 * (chat, workbench, discussions, overview, documentation, products) downloaded
 * mermaid up front, and every page downloaded the KaTeX CSS from `globals.css`.
 * They now load through `next/dynamic` or a dynamic `import()` when a view has
 * something for them to draw.
 *
 * This guard reads the source: a static VALUE import of one of these modules
 * anywhere in `ui/src` puts it back in a page bundle. `import type` is erased
 * at compile time and is allowed. A "boundary" module may import the library
 * statically only if nothing imports the boundary module statically in turn —
 * it is itself reached through `next/dynamic`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(dirname, "../src");

const HEAVY = ["mermaid", "@xyflow/react", "react-diff-viewer-continued"] as const;
const HEAVY_CSS = ["katex/dist/katex.min.css", "@xyflow/react/dist/style.css"] as const;

/**
 * Modules allowed to import a heavy library statically, because every caller
 * reaches them through `next/dynamic`. Keyed by path under `ui/src`.
 */
const BOUNDARIES: Record<string, string> = {
  "components/schema-graph-explorer.tsx": "@xyflow/react",
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.(tsx?|css)$/.test(name) || /\.(test|spec|bench)\./.test(name)) return [];
    return [full];
  });
}

const FILES = sourceFiles(SRC).map((full) => ({
  rel: path.relative(SRC, full).split(path.sep).join("/"),
  src: readFileSync(full, "utf8"),
}));

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/@-]/g, "\\$&");
}

/** A static value import (or re-export, or CSS `@import`) of `spec`. */
function staticImportOf(spec: string): RegExp {
  return staticImportMatching(`["']${escape(spec)}["']`);
}

/**
 * A static value import of the `ui/src` module `rel` by ANY specifier that
 * resolves to it: the `@/` alias or a relative path (`./x`, `../components/x`),
 * with or without the extension.
 */
function staticImportOfModule(rel: string): RegExp {
  const base = escape(path.posix.basename(rel).replace(/\.tsx?$/, ""));
  return staticImportMatching(`["'](?:@/|\\.{1,2}/)(?:[^"']*/)?${base}(?:\\.tsx?)?["']`);
}

function staticImportMatching(q: string): RegExp {
  return new RegExp(
    [
      `^\\s*import\\s+(?!type\\b)[^;]*?\\bfrom\\s+${q}`,
      `^\\s*import\\s+${q}`,
      `^\\s*export\\s+(?!type\\b)[^;]*?\\bfrom\\s+${q}`,
      `^\\s*@import\\s+${q}`,
    ].join("|"),
    "m",
  );
}

describe("heavy viewers are not in the page bundles (#272)", () => {
  it("the guard sees the source tree", () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(FILES.some((f) => f.rel === "app/globals.css")).toBe(true);
  });

  for (const spec of [...HEAVY, ...HEAVY_CSS]) {
    it(`nothing imports ${spec} statically outside a lazy boundary`, () => {
      const re = staticImportOf(spec);
      const offenders = FILES.filter(
        (f) => re.test(f.src) && !(BOUNDARIES[f.rel] && spec.startsWith(BOUNDARIES[f.rel])),
      ).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  }

  for (const [boundary, lib] of Object.entries(BOUNDARIES)) {
    it(`${boundary} (${lib}) is only reached through a dynamic import`, () => {
      const spec = `@/${boundary.replace(/\.tsx?$/, "")}`;
      const importers = FILES.filter(
        (f) => f.rel !== boundary && staticImportOfModule(boundary).test(f.src),
      ).map((f) => f.rel);
      expect(importers).toEqual([]);
      const dynamicImporters = FILES.filter((f) =>
        new RegExp(`import\\(\\s*["']${escape(spec)}["']\\s*\\)`).test(f.src),
      );
      expect(dynamicImporters.length).toBeGreaterThan(0);
    });
  }

  it("the patterns catch the import shapes they are meant to", () => {
    const re = staticImportOf("mermaid");
    expect(re.test('import mermaid from "mermaid";')).toBe(true);
    expect(re.test("import { type Mermaid, render } from 'mermaid';")).toBe(true);
    expect(re.test('export { default } from "mermaid";')).toBe(true);
    expect(re.test('import type { Mermaid } from "mermaid";')).toBe(false);
    expect(re.test('const m = await import("mermaid");')).toBe(false);
    expect(
      staticImportOf("katex/dist/katex.min.css").test('@import "katex/dist/katex.min.css";'),
    ).toBe(true);
    const boundary = staticImportOfModule("components/schema-graph-explorer.tsx");
    expect(boundary.test('import X from "@/components/schema-graph-explorer";')).toBe(true);
    expect(boundary.test('import { X } from "./schema-graph-explorer";')).toBe(true);
    expect(boundary.test('import X from "../components/schema-graph-explorer.tsx";')).toBe(true);
    expect(boundary.test('import type { X } from "./schema-graph-explorer";')).toBe(false);
    expect(boundary.test('import X from "./my-schema-graph-explorer";')).toBe(false);
    expect(boundary.test('const X = dynamic(() => import("./schema-graph-explorer"));')).toBe(
      false,
    );
  });
});
