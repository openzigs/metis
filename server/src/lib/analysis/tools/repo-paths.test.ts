/**
 * #2327 — the globs and path fragments a model hands the code tools.
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkRepoGlob,
  checkRepoPathFragment,
  isSensitiveInClone,
  realRepoPath,
  MAX_REPO_GLOB_CHARS,
  MAX_REPO_GLOB_SEGMENTS,
  repoPathError,
} from "./repo-paths.js";

describe("checkRepoGlob", () => {
  it("accepts a repository-relative glob, trimmed and without a leading ./", () => {
    expect(checkRepoGlob("  src/**/*.ts ")).toEqual({ ok: true, value: "src/**/*.ts" });
    expect(checkRepoGlob("././internal/")).toEqual({ ok: true, value: "internal/" });
    expect(checkRepoGlob("*.json")).toEqual({ ok: true, value: "*.json" });
    // A name that merely contains two dots is not a parent segment.
    expect(checkRepoGlob("a..b/c")).toEqual({ ok: true, value: "a..b/c" });
  });

  it.each([
    ["../secrets/*", /'\.\.'/],
    ["src/../../etc/passwd", /'\.\.'/],
    ["..", /'\.\.'/],
    ["/etc/passwd", /absolute/],
    ["~/.ssh/*", /absolute/],
    ["C:/Windows/*", /absolute/],
    ["src\\..\\x", /backslash/],
    ["src/\u0000.ts", /control character/],
    ["", /empty/],
    ["   ", /empty/],
    ["./", /empty/],
    ["x".repeat(MAX_REPO_GLOB_CHARS + 1), /longer than/],
    [
      Array(MAX_REPO_GLOB_SEGMENTS + 1)
        .fill("a")
        .join("/"),
      /segments/,
    ],
  ])("refuses %j", (raw, reason) => {
    const r = checkRepoGlob(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it("words the refusal so a model can repair the call", () => {
    expect(repoPathError("list_files", "pattern", "it is absolute")).toBe(
      'Error: list_files refused "pattern" because it is absolute.',
    );
  });
});

describe("checkRepoPathFragment (#2327)", () => {
  it("takes a substring, so a leading / is kept, not refused", () => {
    expect(checkRepoPathFragment("/handlers/")).toEqual({ ok: true, value: "/handlers/" });
    expect(checkRepoPathFragment("//internal")).toEqual({ ok: true, value: "/internal" });
    expect(checkRepoPathFragment(" reader/ ")).toEqual({ ok: true, value: "reader/" });
  });

  it.each([
    ["/../etc", /'\.\.'/],
    ["/handlers/../..", /'\.\.'/],
    ["/", /empty/],
    ["~/x", /absolute/],
    ["/a\\b", /backslash/],
  ])("refuses %j", (raw, reason) => {
    const r = checkRepoPathFragment(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });
});

describe("isSensitiveInClone (#2327)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "repo-paths-2327-"));
    await mkdir(path.join(dir, ".ssh"), { recursive: true });
    await writeFile(path.join(dir, ".ssh", "id_rsa"), "");
    await writeFile(path.join(dir, "plain.txt"), "");
    await symlink(path.join(dir, ".ssh", "id_rsa"), path.join(dir, "key.txt"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a path sensitive as asked or where it resolves, and nothing else", async () => {
    expect(await isSensitiveInClone(dir, ".ssh/id_rsa")).toBe(true);
    expect(await isSensitiveInClone(dir, "key.txt")).toBe(true);
    expect(await isSensitiveInClone(dir, "plain.txt")).toBe(false);
    expect(await isSensitiveInClone(dir, "absent.txt")).toBe(false);
    expect(await realRepoPath(dir, "key.txt")).toBe(".ssh/id_rsa");
    expect(await realRepoPath(dir, "absent.txt")).toBeNull();
  });
});
