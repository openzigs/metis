/**
 * #2327 — list_files with a model-written pattern: validated, matched without
 * backtracking, never leaving the clone, with totals when cut.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  emptyListTally,
  listCloneFiles,
  listFilesTool,
  MAX_ENTRIES_VISITED,
  MAX_RESULTS,
} from "./list-files.js";

let root: string;
let clone: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "list-files-2327-"));
  clone = path.join(root, "clone");
  const outside = path.join(root, "outside");
  await mkdir(path.join(clone, "src", "deep"), { recursive: true });
  await mkdir(path.join(clone, "many"), { recursive: true });
  await mkdir(path.join(clone, ".git"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(clone, "src", "a.ts"), "");
  await writeFile(path.join(clone, "src", "deep", "b.ts"), "");
  await writeFile(path.join(clone, "src", "secret.ts"), "");
  await writeFile(path.join(clone, ".env"), "TOKEN=1\n");
  await writeFile(path.join(clone, ".git", "config"), "");
  await writeFile(path.join(outside, "x.ts"), "");
  for (let i = 0; i < MAX_RESULTS + 20; i++) {
    await writeFile(path.join(clone, "many", `f${String(i).padStart(3, "0")}.txt`), "");
  }
  await symlink(outside, path.join(clone, "src", "escape"));
  await symlink(path.join(outside, "x.ts"), path.join(clone, "src", "out.ts"));
  await symlink(path.join(clone, ".env"), path.join(clone, "src", "env.ts"));
  await symlink("..", path.join(clone, "src", "loop"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const list = (pattern: unknown) =>
  listFilesTool.execute({ pattern }, { projectId: "p", cloneDir: clone });

describe("list_files (#2327)", () => {
  it("matches ** as zero or more directories, in a stable order", async () => {
    const r = await list("src/**/*.ts");
    expect(r.content.split("\n")).toEqual(["src/a.ts", "src/deep/b.ts", "src/secret.ts"]);
    expect(r).toMatchObject({ truncated: false, resultCount: 3 });
    expect((await list("src/**")).content.split("\n")).toEqual([
      "src/a.ts",
      "src/deep/b.ts",
      "src/secret.ts",
    ]);
  });

  it("never lists a symlink, hidden entries, or anything outside the clone", async () => {
    const r = await list("**");
    expect(r.content).not.toMatch(/escape|out\.ts|env\.ts|loop|\.env|\.git|x\.ts/);
  });

  it.each(["../outside/*", "src/../../outside/*", "/etc/*", "~/x", "C:/x", "src\\*"])(
    "refuses the pattern %j",
    async (pattern) => {
      const r = await list(pattern);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/^Error: list_files refused "pattern" because/);
    },
  );

  it("reports the total when it cuts the list", async () => {
    const r = await list("many/*");
    expect(r.resultCount).toBe(MAX_RESULTS);
    expect(r.truncated).toBe(true);
    expect(r.content.split("\n").at(-1)).toBe(
      `[truncated: showing ${MAX_RESULTS} of ${MAX_RESULTS + 20} matching file(s); narrow the pattern to see the rest]`,
    );
  });

  it("says the walk was cut short, with or without a match", async () => {
    const hit = emptyListTally();
    await listCloneFiles(clone, { pattern: "many/*" }, hit, { maxEntriesVisited: 10 });
    expect(hit.cutShort).toBe(true);
    const miss = emptyListTally();
    await listCloneFiles(clone, { pattern: "nothing/*" }, miss, { maxEntriesVisited: 3 });
    const { listFilesResult } = await import("./list-files.js");
    expect(listFilesResult({ pattern: "nothing/*" }, miss)).toEqual({
      content: `No files matching pattern: nothing/* among the first ${MAX_ENTRIES_VISITED} entries; more were not listed. Narrow the pattern to a directory.`,
      truncated: true,
      resultCount: 0,
    });
    expect(listFilesResult({ pattern: "many/*" }, hit).content).toMatch(/of at least \d+ matching/);
  });

  it("an excluded file is neither listed nor counted", async () => {
    const tally = emptyListTally();
    await listCloneFiles(clone, { pattern: "src/*.ts" }, tally, {
      isExcluded: (rel) => rel === "src/secret.ts",
    });
    expect(tally).toEqual({ shown: ["src/a.ts"], total: 1, cutShort: false });
  });

  it("matches a catastrophic-backtracking pattern within a bound", async () => {
    const started = performance.now();
    const r = await list(`${"*a".repeat(40)}*b`);
    expect(r.resultCount).toBe(0);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("reports a clone directory that is not there", async () => {
    const r = await listFilesTool.execute(
      { pattern: "*" },
      { projectId: "p", cloneDir: path.join(root, "absent") },
    );
    expect(r).toEqual({ content: "Error: Repository clone directory not found.", isError: true });
  });
});
