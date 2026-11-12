/**
 * #2327 — the globs and path fragments a model hands the code tools.
 */
import { describe, expect, it } from "vitest";
import {
  checkRepoGlob,
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
