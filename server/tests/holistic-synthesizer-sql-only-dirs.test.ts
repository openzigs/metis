/**
 * Holistic synthesizer — SQL-only-directory module discovery (#278).
 *
 * A directory under the clone that contains ONLY `.sql` files yields no
 * CodeSymbol rows (SQL is not a code-graph-parsed language), so it never
 * produces a CodeSymbol-derived ModuleGroup and its constraints/triggers/views
 * are never mined. {@link discoverSqlOnlyModules} closes that gap by
 * synthesizing bounded, empty-`syms` ModuleGroups for such directories so the
 * existing per-module SQL mining pass runs on them end to end.
 */
import { describe, expect, it } from "vitest";
import {
  SQL_SCAN_DIR_CAP,
  discoverSqlOnlyModules,
} from "../src/lib/docs-gen/holistic-synthesizer.js";
import { sqlScanIncompleteWarning } from "../src/lib/docs-gen/grounding/degraded-warnings.js";

/**
 * Build a fake readdir(withFileTypes) implementation backed by an in-memory
 * tree. `tree` maps a directory's relative path to its child entries.
 */
function fakeReaddir(tree: Record<string, Array<{ name: string; dir: boolean }>>) {
  return async (absDir: string) => {
    // The helper resolves paths against cloneDir; we key the tree by the path
    // suffix after the clone root marker "/clone".
    const rel = absDir.split("/clone").pop()?.replace(/^\//, "") ?? "";
    const entries = tree[rel];
    if (!entries) throw new Error(`ENOENT: ${absDir}`);
    return entries.map((e) => ({
      name: e.name,
      isFile: () => !e.dir,
      isDirectory: () => e.dir,
    }));
  };
}

const CLONE = "/clone";

describe("discoverSqlOnlyModules", () => {
  it("synthesizes a module for a directory containing only .sql files", async () => {
    const readdir = fakeReaddir({
      "": [
        { name: "db", dir: true },
        { name: "main.go", dir: false },
      ],
      db: [
        { name: "schema.sql", dir: false },
        { name: "triggers.sql", dir: false },
      ],
    });
    const mods = await discoverSqlOnlyModules(CLONE, new Set<string>(), readdir);
    expect(mods.length).toBe(1);
    expect(mods[0].dir).toBe("db");
    expect(mods[0].syms).toEqual([]);
  });

  it("does NOT synthesize a module for a dir already represented by symbols", async () => {
    const readdir = fakeReaddir({
      "": [{ name: "db", dir: true }],
      db: [{ name: "schema.sql", dir: false }],
    });
    const mods = await discoverSqlOnlyModules(CLONE, new Set(["db"]), readdir);
    expect(mods).toHaveLength(0);
  });

  it("recurses into nested directories to find SQL-only leaves", async () => {
    const readdir = fakeReaddir({
      "": [{ name: "sql", dir: true }],
      sql: [{ name: "migrations", dir: true }],
      "sql/migrations": [
        { name: "001_init.sql", dir: false },
        { name: "002_add.sql", dir: false },
      ],
    });
    const mods = await discoverSqlOnlyModules(CLONE, new Set<string>(), readdir);
    expect(mods.some((m) => m.dir === "sql/migrations")).toBe(true);
  });

  it("ignores directories with no .sql files", async () => {
    const readdir = fakeReaddir({
      "": [{ name: "src", dir: true }],
      src: [
        { name: "a.ts", dir: false },
        { name: "b.ts", dir: false },
      ],
    });
    const mods = await discoverSqlOnlyModules(CLONE, new Set<string>(), readdir);
    expect(mods).toHaveLength(0);
  });

  it("skips test/build/node_modules directories", async () => {
    const readdir = fakeReaddir({
      "": [
        { name: "node_modules", dir: true },
        { name: "tests", dir: true },
        { name: "build", dir: true },
      ],
      node_modules: [{ name: "x.sql", dir: false }],
      tests: [{ name: "y.sql", dir: false }],
      build: [{ name: "z.sql", dir: false }],
    });
    const mods = await discoverSqlOnlyModules(CLONE, new Set<string>(), readdir);
    expect(mods).toHaveLength(0);
  });

  it("finds every SQL-only directory — past the old 24-module cap", async () => {
    // 50 sibling dirs each with a .sql file: every one is a module.
    const root = Array.from({ length: 50 }, (_, i) => ({ name: `d${i}`, dir: true }));
    const tree: Record<string, Array<{ name: string; dir: boolean }>> = { "": root };
    for (let i = 0; i < 50; i++) {
      tree[`d${i}`] = [{ name: "s.sql", dir: false }];
    }
    const stats = { visited: 0, truncated: false, unreadable: [] as string[] };
    const mods = await discoverSqlOnlyModules(CLONE, new Set<string>(), fakeReaddir(tree), stats);
    expect(mods).toHaveLength(50);
    expect(stats).toEqual({ visited: 51, truncated: false, unreadable: [] });
  });

  it("visits past the old 2,000-directory cap", async () => {
    const n = 2_500;
    const tree: Record<string, Array<{ name: string; dir: boolean }>> = {
      "": Array.from({ length: n }, (_, i) => ({ name: `d${i}`, dir: true })),
    };
    for (let i = 0; i < n; i++)
      tree[`d${i}`] = i === n - 1 ? [{ name: "last.sql", dir: false }] : [];
    const stats = { visited: 0, truncated: false, unreadable: [] as string[] };
    const mods = await discoverSqlOnlyModules(CLONE, new Set<string>(), fakeReaddir(tree), stats);
    expect(mods.map((m) => m.dir)).toEqual([`d${n - 1}`]);
    expect(stats.truncated).toBe(false);
    expect(SQL_SCAN_DIR_CAP).toBeGreaterThanOrEqual(100_000);
  });

  it("reports a scan that stops at its safety bound, and unreadable directories, instead of hiding them", async () => {
    const root = Array.from({ length: 10 }, (_, i) => ({ name: `d${i}`, dir: true }));
    const tree: Record<string, Array<{ name: string; dir: boolean }>> = { "": root };
    for (let i = 0; i < 10; i++) tree[`d${i}`] = [{ name: "s.sql", dir: false }];
    const stats = { visited: 0, truncated: false, unreadable: [] as string[] };
    const mods = await discoverSqlOnlyModules(
      CLONE,
      new Set<string>(),
      fakeReaddir(tree),
      stats,
      4,
    );
    expect(mods).toHaveLength(3);
    expect(stats.truncated).toBe(true);
    const failing = async (dir: string) => {
      if (dir.endsWith("d3")) throw new Error("EACCES");
      return fakeReaddir(tree)(dir);
    };
    const s2 = { visited: 0, truncated: false, unreadable: [] as string[] };
    await discoverSqlOnlyModules(CLONE, new Set<string>(), failing, s2);
    expect(s2.unreadable).toEqual(["d3"]);
    const w = sqlScanIncompleteWarning("repo-a", { ...stats, unreadable: ["d3"] });
    expect(w.kind).toBe("source-unavailable");
    expect(w.message).toContain("stopped after 4 directories");
    expect(w.message).toContain("1 directory could not be read (d3)");
  });

  it("returns empty when readdir throws on the root", async () => {
    const readdir = async () => {
      throw new Error("ENOENT");
    };
    const mods = await discoverSqlOnlyModules(CLONE, new Set<string>(), readdir);
    expect(mods).toHaveLength(0);
  });
});
