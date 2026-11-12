/**
 * #736 — chat's bounded file read. Real files on disk (a temp dir per repo), the
 * project's repo list injected; nothing else is stubbed.
 */
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, graphFindMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
  graphFindMany: vi.fn(async () => []),
}));
vi.mock("../../prisma.js", () => ({
  prisma: { repoConnection: { findMany }, codeGraph: { findMany: graphFindMany } },
}));
import {
  createChatReadFileSliceTool,
  isSensitiveRepoPath,
  type ChatReadFileSliceDeps,
} from "./chat-read-file-slice.js";
import { getChatCodeTools, CHAT_CODE_TOOL_NAMES } from "./index.js";
import { codeVersionIndexOf, NO_CODE_VERSIONS } from "../../code-graph/code-version.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "chat-rfs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function repo(id: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(root, id);
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  return dir;
}

/** Repos per project; a repo's clone exists only if it was created on disk. */
function deps(byProject: Record<string, string[]>, calls: string[] = []): ChatReadFileSliceDeps {
  return {
    loadVersions: async () => NO_CODE_VERSIONS,
    listRepoIds: async (projectId) => {
      calls.push(projectId);
      return byProject[projectId] ?? [];
    },
    resolveCloneDir: async (id) => {
      const dir = path.join(root, id);
      try {
        const { stat } = await import("node:fs/promises");
        return (await stat(dir)).isDirectory() ? dir : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

const USER_GO = Array.from({ length: 170 }, (_, i) =>
  i === 163 ? "\tif len(password) < 6 {" : `line ${i + 1}`,
).join("\n");

describe("chat read_file_slice (#736)", () => {
  it("is offered on the chat code-tool surface and nameable in an allowlist", () => {
    expect(getChatCodeTools().map((t) => t.name)).toContain("read_file_slice");
    expect(CHAT_CODE_TOOL_NAMES).toContain("read_file_slice");
  });

  it("quotes a cited file:line range from the session project's clone", async () => {
    await repo("conn-a", { "internal/validator/user.go": USER_GO });
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a"] }));
    const r = await tool.execute(
      { filePath: "internal/validator/user.go", startLine: 163, endLine: 168 },
      { projectId: "p1" },
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("164| \tif len(password) < 6 {");
    expect(r.content).toContain("internal/validator/user.go (lines 163-168 of 170)");
    expect(r.resultCount).toBe(6);
  });

  it("lists repos for the session's project only", async () => {
    await repo("conn-a", { "a.txt": "A" });
    await repo("conn-b", { "a.txt": "B-secret" });
    const calls: string[] = [];
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a"], p2: ["conn-b"] }, calls));
    const r = await tool.execute({ filePath: "a.txt" }, { projectId: "p1" });
    expect(calls).toEqual(["p1"]);
    expect(r.content).toContain("1| A");
    expect(r.content).not.toContain("B-secret");
  });

  it("falls through to the project's next repo when the file is not in the first", async () => {
    await repo("conn-a", { "a.txt": "A" });
    await repo("conn-b", { "only-in-b.txt": "from B" });
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a", "conn-b"] }));
    const r = await tool.execute({ filePath: "only-in-b.txt" }, { projectId: "p1" });
    expect(r.content).toContain("1| from B");
  });

  it("skips a repo whose clone is gone and reads from one that exists", async () => {
    await repo("conn-b", { "a.txt": "B" });
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-gone", "conn-b"] }));
    const r = await tool.execute({ filePath: "a.txt" }, { projectId: "p1" });
    expect(r.content).toContain("1| B");
  });

  it("reports file-not-found when no repo of the project has the file", async () => {
    await repo("conn-a", { "a.txt": "A" });
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a"] }));
    const r = await tool.execute({ filePath: "missing.go" }, { projectId: "p1" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("File not found: missing.go");
  });

  it("says so plainly when the project has no working tree at all", async () => {
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-gone"] }));
    const r = await tool.execute({ filePath: "a.txt" }, { projectId: "p1" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("No repository working tree is available");
  });

  it("refuses path traversal out of the clone without trying another repo", async () => {
    await repo("conn-a", { "a.txt": "A" });
    // From conn-b's clone this path is IN-tree; from conn-a's it escapes. A
    // refusal must stop the search, not fall through to a repo it resolves in.
    await repo("conn-b", { "secret.txt": "B-secret" });
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a", "conn-b"] }));
    const r = await tool.execute({ filePath: "../conn-b/secret.txt" }, { projectId: "p1" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Path traversal detected");
    expect(r.content).not.toContain("B-secret");
  });

  it("refuses a symlink that escapes the clone", async () => {
    const dir = await repo("conn-a", { "a.txt": "A" });
    await writeFile(path.join(root, "secret.txt"), "TOP-SECRET");
    await symlink(path.join(root, "secret.txt"), path.join(dir, "link.txt"));
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a"] }));
    const r = await tool.execute({ filePath: "link.txt" }, { projectId: "p1" });
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("TOP-SECRET");
  });

  it("rejects bad args with a repairable message before touching any repo", async () => {
    const calls: string[] = [];
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a"] }, calls));
    const r = await tool.execute({}, { projectId: "p1" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("filePath");
    expect(calls).toEqual([]);
  });

  it("refuses an unscoped call", async () => {
    const calls: string[] = [];
    const tool = createChatReadFileSliceTool(deps({}, calls));
    const r = await tool.execute({ filePath: "a.txt" }, { projectId: "" });
    expect(r.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("caps one call at 200 lines", async () => {
    await repo("conn-a", {
      "big.txt": Array.from({ length: 500 }, (_, i) => `L${i + 1}`).join("\n"),
    });
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a"] }));
    const r = await tool.execute(
      { filePath: "big.txt", startLine: 1, endLine: 500 },
      { projectId: "p1" },
    );
    expect(r.resultCount).toBe(200);
    expect(r.truncated).toBe(true);
  });
});

describe("chat read_file_slice — the default repo lookup (#736)", () => {
  it("lists only the session project's live repos, primary first", async () => {
    findMany.mockResolvedValueOnce([{ id: "conn-x" }]);
    const resolved: string[] = [];
    const tool = createChatReadFileSliceTool({
      resolveCloneDir: async (id) => {
        resolved.push(id);
        return undefined;
      },
    });
    await tool.execute({ filePath: "a.txt" }, { projectId: "p1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "p1", deletedAt: null },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      }),
    );
    expect(resolved).toEqual(["conn-x"]);
  });

  it("refuses git internals and credential files that exist in the clone, without reading them", async () => {
    await repo("conn-a", {
      ".git/config": "[remote] url = https://x-access-token:SECRET@github.com/o/r",
      ".env": "DB_PASSWORD=SECRET",
      "deploy/.ENV.local": "TOKEN=SECRET",
      ".netrc": "machine github.com password SECRET",
    });
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a"] }));
    for (const filePath of [
      ".git/config",
      ".env",
      "deploy/.ENV.local",
      ".netrc",
      "deploy/../.git/config",
    ]) {
      const r = await tool.execute({ filePath }, { projectId: "p1" });
      expect(r.isError, filePath).toBe(true);
      expect(r.content, filePath).toContain("not readable from chat");
      expect(r.content, filePath).not.toContain("SECRET");
    }
  });

  it("still reads env templates and ordinary files whose names merely contain env or git", async () => {
    await repo("conn-a", {
      ".env.example": "DB_PASSWORD=",
      "internal/config/env.go": "package config",
      ".github/workflows/ci.yml": "on: push",
      ".gitignore": "*.db",
    });
    const tool = createChatReadFileSliceTool(deps({ p1: ["conn-a"] }));
    for (const filePath of [
      ".env.example",
      "internal/config/env.go",
      ".github/workflows/ci.yml",
      ".gitignore",
    ]) {
      const r = await tool.execute({ filePath }, { projectId: "p1" });
      expect(r.isError, filePath).toBeUndefined();
    }
  });
});

describe("isSensitiveRepoPath", () => {
  it.each([
    [".git/HEAD", true],
    ["sub\\.git\\config", true],
    [".GIT/config", true],
    [".env", true],
    [".env.production", true],
    ["a/b/.env.local", true],
    [".git-credentials", true],
    [".npmrc", true],
    [".env.example", false],
    [".env.sample", false],
    [".gitignore", false],
    [".gitattributes", false],
    ["environment.go", false],
    ["docs/.github/CODEOWNERS", false],
  ])("%s -> %s", (p, expected) => {
    expect(isSensitiveRepoPath(p)).toBe(expected);
  });
});

const INDEXED = "a".repeat(40);
const MOVED_ON = "b".repeat(40);
const GITHUB = { provider: "github", ownerOrOrg: "acme", repoName: "app", apiBaseUrl: null };

describe("chat read_file_slice — the citation contract (#2325)", () => {
  function versioned(head: string | null, commitSha: string | null = INDEXED) {
    return {
      ...deps({ p1: ["conn-a"] }),
      loadVersions: async () =>
        codeVersionIndexOf([{ repoConnectionId: "conn-a", commitSha, repo: GITHUB }]),
      readHead: async () => head,
    } satisfies ChatReadFileSliceDeps;
  }

  it("states the indexed commit and a pinned permalink when the working tree matches it", async () => {
    await repo("conn-a", { "src/a.ts": "one\ntwo\nthree" });
    const r = await createChatReadFileSliceTool(versioned(INDEXED)).execute(
      { filePath: "./src/a.ts", startLine: 2, endLine: 3 },
      { projectId: "p1" },
    );
    expect(r.citations).toEqual([
      {
        path: "src/a.ts",
        startLine: 2,
        endLine: 3,
        commitSha: INDEXED,
        permalink: `https://github.com/acme/app/blob/${INDEXED}/src/a.ts#L2-L3`,
        truncated: false,
        totalLines: 3,
        stale: false,
      },
    ]);
    expect(r.content).toContain(`Code version: indexed commit ${INDEXED.slice(0, 12)}.`);
    expect(r.content).not.toContain("Stale");
  });

  it("marks a read of a working tree the index is behind stale, naming both commits", async () => {
    await repo("conn-a", { "src/a.ts": "one\ntwo" });
    const r = await createChatReadFileSliceTool(versioned(MOVED_ON)).execute(
      { filePath: "src/a.ts" },
      { projectId: "p1" },
    );
    expect(r.isError).toBeUndefined();
    // Still served, and still a citation: flagged, never dropped.
    expect(r.content).toContain("1| one");
    expect(r.citations?.[0]).toMatchObject({
      commitSha: INDEXED,
      stale: true,
      workingTreeSha: MOVED_ON,
    });
    expect(r.content).toContain("Stale: the index is behind the repository");
    expect(r.content).toContain(MOVED_ON.slice(0, 12));
    expect(r.content).toContain(INDEXED.slice(0, 12));
  });

  it("counts a working tree whose commit cannot be read as stale, never as the indexed one", async () => {
    await repo("conn-a", { "a.txt": "A" });
    const r = await createChatReadFileSliceTool(versioned(null)).execute(
      { filePath: "a.txt" },
      { projectId: "p1" },
    );
    expect(r.citations?.[0]).toMatchObject({ stale: true, workingTreeSha: null });
    expect(r.content).toContain("commit unknown");
  });

  it("says the version is unknown when the index records no commit, and links nothing", async () => {
    await repo("conn-a", { "a.txt": "A" });
    const readHead = vi.fn(async () => MOVED_ON);
    const r = await createChatReadFileSliceTool({ ...versioned(MOVED_ON, null), readHead }).execute(
      { filePath: "a.txt" },
      { projectId: "p1" },
    );
    expect(r.citations?.[0]).toMatchObject({ commitSha: null, permalink: null, stale: false });
    expect(r.content).toContain("Code version: unknown");
    // Nothing to compare against: HEAD is not even read.
    expect(readHead).not.toHaveBeenCalled();
  });

  it("names the next range when the 200-line cap cuts a read", async () => {
    await repo("conn-a", {
      "big.txt": Array.from({ length: 500 }, (_, i) => `L${i + 1}`).join("\n"),
    });
    const r = await createChatReadFileSliceTool(versioned(INDEXED)).execute(
      { filePath: "big.txt", startLine: 1, endLine: 500 },
      { projectId: "p1" },
    );
    expect(r.citations?.[0]).toMatchObject({
      startLine: 1,
      endLine: 200,
      truncated: true,
      totalLines: 500,
      next: { startLine: 201, endLine: 400 },
    });
    expect(r.content).toContain("request lines 201-400 next");
  });

  it("the default version lookup reads the session project's code graphs", async () => {
    await repo("conn-a", { "a.txt": "A" });
    const { loadVersions: _unused, ...rest } = deps({ p1: ["conn-a"] });
    graphFindMany.mockResolvedValueOnce([]);
    const r = await createChatReadFileSliceTool(rest).execute(
      { filePath: "a.txt" },
      { projectId: "p1" },
    );
    expect(r.citations?.[0]?.commitSha).toBeNull();
    expect(graphFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p1" } }),
    );
  });

  it("carries no contract on a refusal", async () => {
    await repo("conn-a", { "a.txt": "A" });
    const r = await createChatReadFileSliceTool(versioned(INDEXED)).execute(
      { filePath: "../escape.txt" },
      { projectId: "p1" },
    );
    expect(r.isError).toBe(true);
    expect(r.citations).toBeUndefined();
  });
});
