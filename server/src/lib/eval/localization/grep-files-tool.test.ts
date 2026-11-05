import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grepFilesTool, MAX_FILE_BYTES, MAX_MATCHES } from "./grep-files-tool.js";

let root: string;
let clone: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "grep-files-"));
  clone = path.join(root, "clone");
  outside = path.join(root, "outside");
  await mkdir(path.join(clone, "internal", "reader"), { recursive: true });
  await mkdir(path.join(clone, ".git"), { recursive: true });
  await mkdir(path.join(clone, "node_modules", "dep"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(
    path.join(clone, "internal", "reader", "feed.go"),
    "package reader\n\nfunc RefreshFeed() error {\n  return refreshFeed()\n}\n",
  );
  await writeFile(path.join(clone, "README.md"), "Call RefreshFeed to update.\n");
  await writeFile(path.join(clone, ".git", "HEAD"), "RefreshFeed in git\n");
  await writeFile(path.join(clone, "node_modules", "dep", "x.js"), "RefreshFeed\n");
  await writeFile(path.join(clone, "blob.bin"), "RefreshFeed\u0000binary");
  await writeFile(path.join(clone, "big.txt"), `RefreshFeed${"x".repeat(MAX_FILE_BYTES)}`);
  await writeFile(path.join(clone, "many.txt"), "needle\n".repeat(MAX_MATCHES + 5));
  await writeFile(path.join(outside, "secret.txt"), "RefreshFeed secret\n");
  await symlink(outside, path.join(clone, "escape"));
  await symlink(path.join(clone, "internal"), path.join(clone, "inner-link"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (args: unknown, cloneDir: string | null = clone) =>
  grepFilesTool.execute(args, { projectId: "p", ...(cloneDir ? { cloneDir } : {}) });

describe("grep_files (eval-only, #1755)", () => {
  it("finds a literal, case-insensitively, as path:line: text, in a stable order", async () => {
    const r = await run({ text: "refreshfeed" });
    expect(r.isError).toBeUndefined();
    expect(r.content.split("\n")).toEqual([
      "inner-link/reader/feed.go:3: func RefreshFeed() error {",
      "inner-link/reader/feed.go:4: return refreshFeed()",
      "internal/reader/feed.go:3: func RefreshFeed() error {",
      "internal/reader/feed.go:4: return refreshFeed()",
      "README.md:1: Call RefreshFeed to update.",
    ]);
    expect(r.resultCount).toBe(5);
  });

  it("never reads hidden directories, node_modules, binary or oversized files, or outside the clone", async () => {
    const r = await run({ text: "RefreshFeed" });
    expect(r.content).not.toMatch(/\.git|node_modules|blob\.bin|big\.txt|secret|escape/);
  });

  it("treats the text as a literal, not a pattern", async () => {
    expect((await run({ text: "Refresh.*" })).resultCount).toBe(0);
    expect((await run({ text: "Feed()" })).resultCount).toBe(4);
  });

  it("narrows to paths containing pathContains", async () => {
    const r = await run({ text: "RefreshFeed", pathContains: "INTERNAL/" });
    expect(r.content.split("\n")).toHaveLength(2);
  });

  it("stops at the match cap and says so", async () => {
    const r = await run({ text: "needle" });
    expect(r.resultCount).toBe(MAX_MATCHES);
    expect(r.truncated).toBe(true);
  });

  it("says nothing matched without calling it an error", async () => {
    const r = await run({ text: "no such text" });
    expect(r).toEqual({ content: "No lines contain: no such text", resultCount: 0 });
  });

  it("refuses a missing or one-character text, a missing clone, and a clone that is not there", async () => {
    expect((await run({})).isError).toBe(true);
    expect((await run({ text: "x" })).content).toMatch(/grep_files requires "text"/);
    expect((await run({ text: "abc" }, null)).content).toMatch(/No repository clone/);
    expect((await run({ text: "abc" }, path.join(root, "absent"))).content).toMatch(/not found/);
  });
});
