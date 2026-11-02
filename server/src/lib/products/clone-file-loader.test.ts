/**
 * #1643 — the clone loader reads a connector's clone, never outside it, and no
 * more than the crawl's limits.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCloneFileLoader, readCloneFiles } from "./clone-file-loader.js";

const repo = (repoConnectionId: string) => ({
  repoConnectionId,
  repoName: repoConnectionId,
  ownerOrOrg: "org",
  defaultBranch: "main",
});
const LIMITS = { maxFiles: 500, maxBytes: 1024 * 1024 };

let tmp: string;
const write = (rel: string, content: string | Buffer) => {
  const abs = path.join(tmp, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
};

beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "metis-clone-loader-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("readCloneFiles", () => {
  it("reads every file under the root, by relative path, in sorted order", async () => {
    write("a/src/z.ts", "export const z = 1;");
    write("a/src/b.ts", "export const b = 1;");
    write("a/openapi.yaml", "openapi: 3.0.0\n");
    const files = await readCloneFiles(path.join(tmp, "a"), LIMITS);
    expect(files).toEqual([
      { path: "openapi.yaml", content: "openapi: 3.0.0\n", size: 15 },
      { path: "src/b.ts", content: "export const b = 1;", size: 19 },
      { path: "src/z.ts", content: "export const z = 1;", size: 19 },
    ]);
  });

  it("does not walk the directories the crawl skips", async () => {
    write("skip/.git/HEAD", "ref: refs/heads/main\n");
    write("skip/node_modules/x/index.js", "module.exports = 1;");
    write("skip/src/a.ts", "a");
    const files = await readCloneFiles(path.join(tmp, "skip"), LIMITS);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });

  it("follows no symlink out of the root, to a file or a directory", async () => {
    const secret = write("outside/secret.sql", "INSERT INTO secrets VALUES (1);");
    write("linked/src/a.sql", "select 1;");
    symlinkSync(secret, path.join(tmp, "linked", "escape.sql"));
    symlinkSync(path.dirname(secret), path.join(tmp, "linked", "dir"));
    const files = await readCloneFiles(path.join(tmp, "linked"), LIMITS);
    expect(files.map((f) => f.path)).toEqual(["src/a.sql"]);
    expect(files.some((f) => f.content.includes("secrets"))).toBe(false);
  });

  it("reads no more files than the file limit", async () => {
    for (const n of [1, 2, 3, 4]) write(`many/d${n}/f.ts`, `${n}`);
    const files = await readCloneFiles(path.join(tmp, "many"), { ...LIMITS, maxFiles: 2 });
    expect(files.map((f) => f.path)).toEqual(["d1/f.ts", "d2/f.ts"]);
  });

  it("reads no more bytes than the byte limit, skipping a file that does not fit", async () => {
    write("bytes/a.ts", "12345");
    write("bytes/b.ts", "1234567890");
    write("bytes/c.ts", "123");
    const files = await readCloneFiles(path.join(tmp, "bytes"), { ...LIMITS, maxBytes: 9 });
    expect(files.map((f) => f.path)).toEqual(["a.ts", "c.ts"]);
    expect(files.reduce((n, f) => n + f.size, 0)).toBeLessThanOrEqual(9);
  });

  it("hands on no binary file", async () => {
    write("bin/logo.png", Buffer.from([0x89, 0x50, 0x00, 0x47]));
    write("bin/a.ts", "a");
    const files = await readCloneFiles(path.join(tmp, "bin"), LIMITS);
    expect(files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("returns nothing for a root that does not exist", async () => {
    expect(await readCloneFiles(path.join(tmp, "missing"), LIMITS)).toEqual([]);
  });
});

describe("createCloneFileLoader", () => {
  const originalCloneDir = process.env.REPO_CLONE_DIR;
  afterEach(() => {
    if (originalCloneDir === undefined) delete process.env.REPO_CLONE_DIR;
    else process.env.REPO_CLONE_DIR = originalCloneDir;
  });

  it("returns null for a repo with no clone", async () => {
    const load = createCloneFileLoader({ resolveRoot: async () => null });
    expect(await load(repo("rc-none"))).toBeNull();
  });

  it("reads the connector's clone under the clone root by default", async () => {
    process.env.REPO_CLONE_DIR = path.join(tmp, "clones");
    write("clones/rc1/.git/HEAD", "ref: refs/heads/main\n");
    write("clones/rc1/db/x.sql", "select 1;");
    const load = createCloneFileLoader();
    expect((await load(repo("rc1")))?.map((f) => f.path)).toEqual(["db/x.sql"]);
    // A directory with no checkout in it is not a clone.
    write("clones/rc2/db/x.sql", "select 1;");
    expect(await load(repo("rc2"))).toBeNull();
  });

  it("passes its limits on", async () => {
    write("lim/a.ts", "a");
    write("lim/b.ts", "b");
    const load = createCloneFileLoader({
      resolveRoot: async () => path.join(tmp, "lim"),
      maxFiles: 1,
    });
    expect((await load(repo("rc")))?.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("passes its byte limit on", async () => {
    write("bytes/a.ts", "aaaa");
    write("bytes/b.ts", "bbbb");
    const load = createCloneFileLoader({
      resolveRoot: async () => path.join(tmp, "bytes"),
      maxBytes: 5,
    });
    expect((await load(repo("rc")))?.map((f) => f.path)).toEqual(["a.ts"]);
  });
});
