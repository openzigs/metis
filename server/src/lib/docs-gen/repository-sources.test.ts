import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
vi.mock("../prisma.js", () => ({ prisma: { codeGraph: { findMany } } }));

import {
  loadRepositorySources,
  repositoryPathIdentity,
  resolveSourcePath,
} from "./repository-sources.js";

const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "metis-1354-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("#1354 repository sources", () => {
  it("resolves every graph's own active connector, never the first repository", async () => {
    const root = await fixture();
    vi.stubEnv("REPO_CLONE_DIR", root);
    for (const id of ["a", "b"]) {
      await mkdir(path.join(root, id, ".git"), { recursive: true });
      await writeFile(path.join(root, id, ".git/HEAD"), "ref: refs/heads/main");
    }
    findMany.mockResolvedValue(
      ["a", "b"].map((id) => ({
        id: `graph-${id}`,
        repoConnection: { id, projectId: "p", deletedAt: null },
      })),
    );
    const sources = await loadRepositorySources({ projectId: "p" });
    expect([...sources.values()]).toEqual(
      ["a", "b"].map((id) => ({
        codeGraphId: `graph-${id}`,
        repoConnectorId: id,
        root: path.join(root, id),
        commitSha: null,
      })),
    );
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: "p" } }));
  });

  it("keeps missing, deleted, foreign and unlinked roots unavailable with graph identity", async () => {
    vi.stubEnv("REPO_CLONE_DIR", await fixture());
    findMany.mockResolvedValue([
      { id: "missing", repoConnection: { id: "absent-1354", projectId: "p", deletedAt: null } },
      { id: "deleted", repoConnection: { id: "d", projectId: "p", deletedAt: new Date() } },
      { id: "foreign", repoConnection: { id: "f", projectId: "other", deletedAt: null } },
      { id: "unlinked", repoConnection: null },
    ]);
    const sources = await loadRepositorySources({ projectId: "p", codeGraphId: "missing" });
    expect([...sources.values()].map((s) => s.root)).toEqual([null, null, null, null]);
    expect(sources.get("unlinked")).toMatchObject({
      codeGraphId: "unlinked",
      repoConnectorId: null,
      commitSha: null,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p", id: "missing" },
      }),
    );
  });

  it("encodes graph, connector and exact path without delimiter or sanitization collisions", () => {
    const a = { codeGraphId: "g:a", repoConnectorId: "repo/a" };
    const b = { codeGraphId: "g", repoConnectorId: "a:repo/a" };
    const ids = [
      repositoryPathIdentity(a, "src/a"),
      repositoryPathIdentity(b, "src/a"),
      repositoryPathIdentity(a, "src:a"),
      repositoryPathIdentity(a, "src_a"),
      repositoryPathIdentity({ codeGraphId: "orphan", repoConnectorId: null }, "src/a"),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(repositoryPathIdentity(a, "src/a")).toBe(ids[0]);
    expect(repositoryPathIdentity(undefined, "src/a")).toBe("src/a");
  });

  it("rejects path-shaped connector IDs and clone roots aliased to another repository", async () => {
    const root = await fixture();
    vi.stubEnv("REPO_CLONE_DIR", root);
    await mkdir(path.join(root, "valid/.git"), { recursive: true });
    await writeFile(path.join(root, "valid/.git/HEAD"), "ref: refs/heads/main");
    await symlink(path.join(root, "valid"), path.join(root, "alias"));
    findMany.mockResolvedValue(
      ["../valid", "alias"].map((id) => ({
        id,
        repoConnection: { id, projectId: "p", deletedAt: null },
      })),
    );
    const sources = await loadRepositorySources({ projectId: "p" });
    expect([...sources.values()].map((source) => source.root)).toEqual([null, null]);
  });

  it("allows only real paths inside the selected source root (including internal symlinks)", async () => {
    const root = await fixture();
    await mkdir(path.join(root, "a/src"), { recursive: true });
    await mkdir(path.join(root, "b/src"), { recursive: true });
    await writeFile(path.join(root, "a/src/a.ts"), "A");
    await writeFile(path.join(root, "b/src/a.ts"), "B");
    await symlink(path.join(root, "b/src/a.ts"), path.join(root, "a/escape.ts"));
    await symlink(path.join(root, "a/src/a.ts"), path.join(root, "a/internal.ts"));
    const a = path.join(root, "a");
    expect(await resolveSourcePath(a, "src/a.ts")).toBe(path.join(root, "a/src/a.ts"));
    expect(await resolveSourcePath(a, "internal.ts")).toBe(path.join(root, "a/src/a.ts"));
    for (const file of [
      "../b/src/a.ts",
      path.join(root, "b/src/a.ts"),
      "C:\\outside.ts",
      "..\\b\\src\\a.ts",
      "escape.ts",
      "missing.ts",
    ]) {
      await expect(resolveSourcePath(a, file)).rejects.toThrow();
    }
    await expect(resolveSourcePath(null, "src/a.ts")).rejects.toThrow();
  });
});
