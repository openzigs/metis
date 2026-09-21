/**
 * `resolveServerRoot()` must point at the `server/` package root regardless of
 * the caller's cwd and regardless of whether this module was loaded from
 * `src/lib` (tsx dev) or `dist/lib` (packaged build).
 *
 * Regression: it previously resolved a single `..` from its own directory,
 * yielding `server/src` in dev and `server/dist` in a build. Every
 * `resolveDataDir()` consumer inherited that offset -- most visibly
 * `REPO_CLONE_DIR`, so repo ingest cloned into `server/src/data/repo-clones/<id>`
 * while cwd-relative readers looked under `server/data/repo-clones/<id>`.
 * Doc generation then reported "N of N modules could not be read from the
 * project's source on disk" for a project whose clone was present and healthy.
 */
import path from "node:path";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveDataDir, resolveServerRoot } from "./server-root.js";

describe("resolveServerRoot", () => {
  it("resolves to the server package root, not src/ or dist/", () => {
    const root = resolveServerRoot();
    expect(path.basename(root)).toBe("server");
    expect(path.basename(root)).not.toBe("src");
    expect(path.basename(root)).not.toBe("dist");
  });

  it("points at a directory that actually contains the server package manifest", () => {
    expect(existsSync(path.join(resolveServerRoot(), "package.json"))).toBe(true);
  });

  it("is independent of process.cwd()", () => {
    const before = resolveServerRoot();
    const cwd = process.cwd();
    try {
      process.chdir(path.parse(cwd).root);
      expect(resolveServerRoot()).toBe(before);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("resolveDataDir", () => {
  it("anchors the default under <serverRoot>/data", () => {
    expect(resolveDataDir(undefined, "repo-clones")).toBe(
      path.join(resolveServerRoot(), "data", "repo-clones"),
    );
  });

  it("resolves a relative override against the server root, not src/", () => {
    // This is the exact `.env` value that regressed.
    const resolved = resolveDataDir("./data/repo-clones");
    expect(resolved).toBe(path.join(resolveServerRoot(), "data", "repo-clones"));
    expect(resolved).not.toContain(`${path.sep}src${path.sep}data${path.sep}`);
  });

  it("uses an absolute override as-is", () => {
    const abs = path.resolve(path.sep, "var", "metis", "clones");
    expect(resolveDataDir(abs)).toBe(abs);
  });
});
