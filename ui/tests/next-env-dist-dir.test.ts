/**
 * `ui/next-env.d.ts` is tracked, and `next dev` / `next build` rewrite it to
 * import the route types from whatever `distDir` they ran with. A run with a
 * custom `NEXT_DIST_DIR` (the e2e harness, an isolated worktree dev server)
 * leaves it pointing at that private folder, and lint, typecheck and CI all
 * stay green — so PR #320 shipped `./.next-e2e-l2/...` without anyone seeing
 * it. The committed file must reference only the default `.next` dist dir.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../next-env.d.ts");

/** Every relative path the file imports or references. */
function localPaths(src: string): string[] {
  return [...src.matchAll(/(?:import\s+|path=)["'](\.\/[^"']+)["']/g)].map((m) => m[1]);
}

describe("next-env.d.ts points at the default dist dir", () => {
  it("imports only from ./.next/", () => {
    const paths = localPaths(readFileSync(FILE, "utf8"));
    expect(paths.filter((p) => !p.startsWith("./.next/"))).toEqual([]);
  });

  it("the path extraction sees the shapes next writes", () => {
    expect(localPaths('import "./.next-e2e-l2/dev/types/routes.d.ts";')).toEqual([
      "./.next-e2e-l2/dev/types/routes.d.ts",
    ]);
    expect(localPaths('/// <reference path="./.next/types/routes.d.ts" />')).toEqual([
      "./.next/types/routes.d.ts",
    ]);
    expect(localPaths('/// <reference types="next" />')).toEqual([]);
  });
});
