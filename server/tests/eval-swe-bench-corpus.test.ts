/**
 * Epic #194 (C.1) — SWE-bench-Pro corpus loader tests.
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { defaultCacheDir, loadCorpus, parseJsonl } from "../src/lib/eval/swe-bench/corpus.js";

const sample = {
  taskId: "astropy__astropy-12907",
  repo: "astropy/astropy",
  baseCommit: "abcdef",
  prompt: "Fix the bug",
  expectedPatch: "diff --git a/x.py b/x.py\n@@\n-old\n+new",
  testCommand: "pytest -q",
};

let tmp: string | null = null;

afterEach(async () => {
  if (tmp) {
    await fs.rm(tmp, { recursive: true, force: true });
    tmp = null;
  }
});

describe("defaultCacheDir", () => {
  it("includes the metis eval-cache namespace", () => {
    expect(defaultCacheDir()).toContain(path.join(".metis", "eval-cache", "swe-bench"));
  });
});

describe("parseJsonl", () => {
  it("parses one task per line and skips blanks", () => {
    const raw = `${JSON.stringify(sample)}\n\n${JSON.stringify({ ...sample, taskId: "x__y-1" })}\n`;
    const parsed = parseJsonl(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.taskId).toBe("astropy__astropy-12907");
  });

  it("throws on missing required fields", () => {
    const raw = JSON.stringify({ taskId: "broken" });
    expect(() => parseJsonl(raw)).toThrow(/missing required fields/);
  });
});

describe("loadCorpus", () => {
  it("returns inMemory tasks when provided and respects limit", async () => {
    const tasks = await loadCorpus({
      inMemory: [sample, { ...sample, taskId: "x__y-1" }, { ...sample, taskId: "x__y-2" }],
      limit: 2,
    });
    expect(tasks.map((t) => t.taskId)).toEqual(["astropy__astropy-12907", "x__y-1"]);
  });

  it("reads the manifest from the cache dir when no inMemory list", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swe-corpus-"));
    await fs.writeFile(path.join(tmp, "tasks.jsonl"), `${JSON.stringify(sample)}\n`, "utf8");
    const tasks = await loadCorpus({ cacheDir: tmp });
    expect(tasks).toHaveLength(1);
  });

  it("throws a helpful error when the manifest is missing", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "swe-corpus-"));
    await expect(loadCorpus({ cacheDir: tmp })).rejects.toThrow(/manifest not found/);
  });
});
