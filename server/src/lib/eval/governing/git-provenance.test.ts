import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitProvenance, type GitRunner } from "./git-provenance.js";

/** A runner that answers each git subcommand from `out`, or throws for one it lacks. */
const fakeGit =
  (out: Record<string, string>): GitRunner =>
  (args) => {
    const answer = out[args[0]!];
    if (answer === undefined) throw new Error(`git ${args.join(" ")} failed`);
    return answer;
  };

describe("gitProvenance (#2063)", () => {
  const COMMIT = "0123456789abcdef0123456789abcdef01234567";

  it("names the HEAD commit and a clean tree", () => {
    const seen: Array<{ args: readonly string[]; cwd: string }> = [];
    const git: GitRunner = (args, cwd) => {
      seen.push({ args, cwd });
      return fakeGit({ "rev-parse": `${COMMIT}\n`, status: "" })(args, cwd);
    };
    expect(gitProvenance("/repo", git)).toEqual({ commit: COMMIT, dirty: false });
    expect(seen).toEqual([
      { args: ["rev-parse", "HEAD"], cwd: "/repo" },
      { args: ["status", "--porcelain"], cwd: "/repo" },
    ]);
  });

  it("reads any porcelain line, untracked files included, as uncommitted changes", () => {
    expect(
      gitProvenance("/repo", fakeGit({ "rev-parse": COMMIT, status: "?? new-file.ts\n" })),
    ).toEqual({ commit: COMMIT, dirty: true });
  });

  it("says null for what git cannot answer, never a guess", () => {
    expect(gitProvenance("/repo", fakeGit({ status: "" }))).toEqual({ commit: null, dirty: false });
    expect(gitProvenance("/repo", fakeGit({ "rev-parse": COMMIT }))).toEqual({
      commit: COMMIT,
      dirty: null,
    });
    expect(gitProvenance("/repo", fakeGit({}))).toEqual({ commit: null, dirty: null });
  });

  describe("with the real git", () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
    });

    it("runs in the directory it is given, not the process's", () => {
      dir = mkdtempSync(path.join(tmpdir(), "governing-provenance-"));
      execFileSync("git", ["init", "-q"], { cwd: dir });
      // A repository with no commit yet: no HEAD to name, and a clean tree.
      expect(gitProvenance(dir)).toEqual({ commit: null, dirty: false });
      writeFileSync(path.join(dir, "a.txt"), "x");
      expect(gitProvenance(dir)).toEqual({ commit: null, dirty: true });
    });
  });
});
