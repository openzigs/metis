import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import {
  cleanTargets,
  isCleanTarget,
  isWithinRoot,
  findCleanMatches,
  removeMatches,
  runClean,
} from "./clean.mjs";

/** Build a Dirent-like entry. */
function dirent(name: string, isDir = true) {
  return { name, isDirectory: () => isDir };
}

describe("cleanTargets", () => {
  it("matches the documented glob set exactly", () => {
    expect([...cleanTargets].sort()).toEqual([".next", "coverage", "dist", "node_modules"]);
  });

  it("isCleanTarget recognizes each target and rejects others", () => {
    for (const t of cleanTargets) expect(isCleanTarget(t)).toBe(true);
    expect(isCleanTarget("src")).toBe(false);
    expect(isCleanTarget("node_modules2")).toBe(false);
  });
});

describe("isWithinRoot", () => {
  const root = path.resolve("/repo");
  it("accepts a nested path", () => {
    expect(isWithinRoot(root, path.join(root, "ui", "dist"))).toBe(true);
  });
  it("rejects the root itself", () => {
    expect(isWithinRoot(root, root)).toBe(false);
  });
  it("rejects an escaping path", () => {
    expect(isWithinRoot(root, path.resolve(root, "..", "evil"))).toBe(false);
  });
  it("rejects an unrelated absolute path", () => {
    expect(isWithinRoot(root, path.resolve("/etc"))).toBe(false);
  });
});

describe("findCleanMatches", () => {
  const root = path.resolve("/repo");

  it("finds nested targets and prunes inside them", async () => {
    const tree: Record<string, ReturnType<typeof dirent>[]> = {
      [root]: [dirent("node_modules"), dirent("ui"), dirent("server"), dirent("file", false)],
      [path.join(root, "ui")]: [dirent("dist"), dirent(".next"), dirent("src")],
      [path.join(root, "server")]: [dirent("coverage"), dirent("node_modules")],
      // these should never be read because their parents are pruned/targets
    };
    const list = vi.fn(async (dir: string) => tree[dir] ?? []);
    const matches: string[] = await findCleanMatches(root, { list });
    expect(matches.sort()).toEqual(
      [
        path.join(root, "node_modules"),
        path.join(root, "server", "coverage"),
        path.join(root, "server", "node_modules"),
        path.join(root, "ui", ".next"),
        path.join(root, "ui", "dist"),
      ].sort(),
    );
    // never recursed into a matched node_modules
    expect(list).not.toHaveBeenCalledWith(path.join(root, "node_modules"));
  });

  it("survives an unreadable directory", async () => {
    const list = vi.fn(async (dir: string) => {
      if (dir === root) return [dirent("ui")];
      throw new Error("EACCES");
    });
    const matches: string[] = await findCleanMatches(root, { list });
    expect(matches).toEqual([]);
  });
});

describe("removeMatches", () => {
  it("removes each target idempotently and counts them", async () => {
    const remove = vi.fn(async () => {});
    const log = vi.fn();
    const n = await removeMatches(["/repo/dist", "/repo/coverage"], { remove, log });
    expect(n).toBe(2);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith("removed /repo/dist");
  });
});

describe("runClean", () => {
  it("discovers and removes in one pass", async () => {
    const root = path.resolve("/repo");
    const list = vi.fn(async (dir: string) =>
      dir === root ? [dirent("dist"), dirent("src")] : [],
    );
    const remove = vi.fn(async () => {});
    const log = vi.fn();
    const n = await runClean(root, { list, remove, log });
    expect(n).toBe(1);
    expect(remove).toHaveBeenCalledWith(path.join(root, "dist"));
  });
});
