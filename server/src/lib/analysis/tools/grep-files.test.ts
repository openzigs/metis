import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGrepFilesTool,
  emptyGrepTally,
  grepClone,
  grepFilesTool,
  MAX_FILE_BYTES,
  MAX_MATCHES,
  MAX_NEEDLE_CHARS,
  MAX_OUTPUT_CHARS,
} from "./grep-files.js";

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
  await symlink(path.join(clone, "README.md"), path.join(clone, "readme-link.md"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (args: unknown, cloneDir: string | null = clone) =>
  grepFilesTool.execute(args, { projectId: "p", ...(cloneDir ? { cloneDir } : {}) });

describe("grep_files (#1755, promoted to production in #2327)", () => {
  it("finds a literal, case-insensitively, as path:line: text, in a stable order", async () => {
    const r = await run({ text: "refreshfeed" });
    expect(r.isError).toBeUndefined();
    expect(r.content.split("\n")).toEqual([
      "internal/reader/feed.go:3: func RefreshFeed() error {",
      "internal/reader/feed.go:4: return refreshFeed()",
      "readme-link.md:1: Call RefreshFeed to update.",
      "README.md:1: Call RefreshFeed to update.",
    ]);
    expect(r.resultCount).toBe(4);
  });

  it("never reads hidden directories, node_modules, binary or oversized files, or outside the clone", async () => {
    const r = await run({ text: "RefreshFeed" });
    expect(r.content).not.toMatch(/\.git|node_modules|blob\.bin|big\.txt|secret|escape/);
  });

  it("treats the text as a literal, not a pattern", async () => {
    expect((await run({ text: "Refresh.*" })).resultCount).toBe(0);
    expect((await run({ text: "Feed()" })).resultCount).toBe(2);
  });

  it("narrows to paths containing pathContains", async () => {
    const r = await run({ text: "RefreshFeed", pathContains: "INTERNAL/" });
    expect(r.content.split("\n")).toHaveLength(2);
  });

  it("never descends into a symlinked directory, so a cycle cannot loop or hang (#1810)", async () => {
    // The reviewer's two reproductions: a/{x,y} -> ..  and  b/{x,y} -> .
    const loops = await mkdtemp(path.join(tmpdir(), "grep-files-loop-"));
    try {
      await mkdir(path.join(loops, "a"));
      await mkdir(path.join(loops, "b"));
      await writeFile(path.join(loops, "a", "one.txt"), "loopneedle\n");
      await writeFile(path.join(loops, "b", "two.txt"), "loopneedle\n");
      for (const d of ["x", "y"]) {
        await symlink("..", path.join(loops, "a", d));
        await symlink(".", path.join(loops, "b", d));
      }
      const r = await run({ text: "loopneedle" }, loops);
      expect(r.content.split("\n")).toEqual(["a/one.txt:1: loopneedle", "b/two.txt:1: loopneedle"]);
      expect(r.truncated).toBe(false);
    } finally {
      await rm(loops, { recursive: true, force: true });
    }
  }, 5_000);

  it("caps the files it reads among the files in scope, not before pathContains (#1810)", async () => {
    // big.txt and blob.bin sort before README.md: a cap applied before the
    // scope would read only those two and report that nothing matched.
    const r = await createGrepFilesTool({ maxFilesScanned: 2 }).execute(
      { text: "RefreshFeed", pathContains: "readme" },
      { projectId: "p", cloneDir: clone },
    );
    expect(r.content.split("\n")).toEqual([
      "readme-link.md:1: Call RefreshFeed to update.",
      "README.md:1: Call RefreshFeed to update.",
    ]);
    expect(r.truncated).toBe(false);
  });

  it("says the file cap cut the search short, with or without a match (#1810)", async () => {
    const ctx = { projectId: "p", cloneDir: clone };
    // big.txt, blob.bin, internal/reader/feed.go: the cap is reached with files left.
    const hit = await createGrepFilesTool({ maxFilesScanned: 3 }).execute(
      { text: "RefreshFeed" },
      ctx,
    );
    expect(hit.resultCount).toBe(2);
    expect(hit.truncated).toBe(true);
    const miss = await createGrepFilesTool({ maxFilesScanned: 1 }).execute(
      { text: "to update." },
      ctx,
    );
    expect(miss.truncated).toBe(true);
    expect(miss.content).toMatch(/^No lines contain: to update\. in the first 1 file\(s\)/);
    expect(miss.content).toMatch(/pathContains/);
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

  it("says how many lines matched past the cap (#2327)", async () => {
    const r = await run({ text: "needle" });
    expect(r.resultCount).toBe(MAX_MATCHES);
    expect(r.content.split("\n").at(-1)).toMatch(
      new RegExp(
        `^\\[truncated: showing ${MAX_MATCHES} of ${MAX_MATCHES + 5} matching line\\(s\\) in 1 file\\(s\\);`,
      ),
    );
  });
});

describe("grep_files bounds and path safety (#2327)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "grep-files-2327-"));
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, ".git"), { recursive: true });
    await writeFile(path.join(dir, ".env"), "API_TOKEN=hunter2\n");
    await writeFile(path.join(dir, ".git", "config"), "token = hunter2\n");
    await writeFile(path.join(dir, ".netrc"), "password hunter2\n");
    // In-repo links whose names look harmless but resolve to secret files.
    await symlink(path.join(dir, ".env"), path.join(dir, "src", "settings.txt"));
    await symlink(path.join(dir, ".git", "config"), path.join(dir, "src", "gitcfg.txt"));
    await symlink(path.join(dir, ".netrc"), path.join(dir, "src", "net.txt"));
    await writeFile(path.join(dir, "src", "open.ts"), "export const hunter2 = 'public';\n");
    await writeFile(path.join(dir, "src", "hidden.ts"), "export const hunter2 = 'restricted';\n");
    await symlink("hidden.ts", path.join(dir, "src", "alias.ts"));
    await writeFile(path.join(dir, "src", "aaaa.txt"), `${"a".repeat(100_000)}\n`);
    // 30 lines of 200 characters.
    await writeFile(path.join(dir, "src", "wide.txt"), `${"wide ".repeat(40)}\n`.repeat(30));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const grep = (args: unknown) => grepFilesTool.execute(args, { projectId: "p", cloneDir: dir });

  it("never reads .env, .git or .netrc, not even through an in-repo symlink to one", async () => {
    const r = await grep({ text: "hunter2" });
    expect(r.content).not.toMatch(/API_TOKEN|token =|password/);
    expect(r.content).not.toMatch(/settings\.txt|gitcfg\.txt|net\.txt/);
    expect(r.content).toContain("src/open.ts:1:");
  });

  it("refuses a pathContains that is absolute or climbs out with ..", async () => {
    for (const pathContains of ["../outside", "src/../../x", "/etc", "C:/x", "src\\x"]) {
      const r = await grep({ text: "hunter2", pathContains });
      expect(r.isError, pathContains).toBe(true);
      expect(r.content).toMatch(/grep_files refused "pathContains"/);
    }
  });

  it("refuses a needle longer than the cap", async () => {
    const r = await grep({ text: "x".repeat(MAX_NEEDLE_CHARS + 1) });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/longer than/);
  });

  it("treats a catastrophic-backtracking regular expression as literal text, within a bound", async () => {
    const started = performance.now();
    expect(await grep({ text: "(a+)+$" })).toEqual({
      content: "No lines contain: (a+)+$",
      resultCount: 0,
    });
    expect((await grep({ text: "(a|aa)*b" })).resultCount).toBe(0);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("caps the characters returned and reports the totals it cut", async () => {
    const r = await grep({ text: "wide", pathContains: "wide" });
    expect(r.truncated).toBe(true);
    const lines = r.content.split("\n");
    const footer = lines.pop();
    expect(lines.join("\n").length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(lines.length).toBe(r.resultCount);
    expect(lines.length).toBeLessThan(30);
    expect(footer).toBe(
      `[truncated: showing ${lines.length} of 30 matching line(s) in 1 file(s); 1 file(s) searched]`,
    );
  });

  it("an excluded file is neither read nor counted, under its name or through a symlink", async () => {
    const tally = emptyGrepTally();
    const hidden = new Set(["src/hidden.ts"]);
    await grepClone(dir, { text: "hunter2" }, tally, {
      isExcluded: (rel, realRel) => hidden.has(rel) || hidden.has(realRel),
    });
    expect(tally.shown).toEqual(["src/open.ts:1: export const hunter2 = 'public';"]);
    expect(tally.totalMatches).toBe(1);
    expect(tally.matchingFiles).toBe(1);
  });
});
