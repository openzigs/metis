import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Runner-level tests for `pnpm lint:no-nul` (Issue #1215).
 *
 * ## What reading missed
 *
 * The read was wrapped in `catch { continue; }` with the comment "deleted / unreadable
 * in this checkout" — two states named in one breath and handled as one. Deleted is a
 * knowable answer; unreadable is not. Measured on the real runner: a tracked file
 * containing a NUL takes the gate from exit 1 to exit **0** when it is chmod 000 or
 * replaced by a directory, *and* the summary still reads "3 tracked text files, no NUL
 * bytes" — a claim about a file it never opened.
 *
 * That matters more here than the exit code suggests. This gate exists precisely
 * because a NUL is invisible to review: a file it silently declines to scan is the one
 * outcome that must not read as a pass.
 *
 * ## Why the first fix was wrong, and how that was caught
 *
 * Failing on any read error broke **this repository's own tree**: `.claude/skills/*`
 * holds 14 tracked symlinks to directories, so `readFileSync` follows them and throws
 * `EISDIR` on every one. They are not unreadable — a symlink's blob is the link *text*,
 * and the pointed-at files are separately tracked under `.github/skills/`. The
 * classification therefore asks `lstat` what git is storing rather than asking a blind
 * read what it happens to throw, and the symlink arm below pins that.
 */

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-no-nul.mjs");

/**
 * Can this process be denied read access by mode bits? Measured, not inferred: `chmod
 * 000` does not stop root, and CI containers often run as root. The arm skips there —
 * the EISDIR arm covers the same classification without needing privilege semantics.
 */
const MODE_BITS_ENFORCED = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "nul-mode-"));
  try {
    const target = path.join(probe, "denied");
    fs.writeFileSync(target, "x", "utf8");
    fs.chmodSync(target, 0o000);
    try {
      fs.readFileSync(target);
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

/** @type {string[]} */
const created = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    try {
      // Restore any mode the arms cleared, or the cleanup itself fails.
      for (const entry of fs.readdirSync(path.join(dir, "src"), { withFileTypes: true })) {
        if (entry.isFile()) fs.chmodSync(path.join(dir, "src", entry.name), 0o644);
      }
    } catch {
      /* the arm may not have created src/ */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A throwaway repository holding one clean tracked file, plus whatever the arm adds.
 *
 * @returns {string}
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-no-nul-"));
  created.push(dir);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "clean.ts"), "export const ok = 1;\n", "utf8");
  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
  return dir;
}

/** @param {string} dir @param {string} relativePath */
function trackNulFile(dir, relativePath) {
  // Written through a Buffer so the NUL is a real byte on disk, not an escape.
  fs.writeFileSync(path.join(dir, relativePath), Buffer.from('const x = "\0";\n', "utf8"));
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
}

/** @param {string} dir @returns {{ status: number, output: string }} */
function run(dir) {
  const result = spawnSync(process.execPath, [scriptPath], { cwd: dir, encoding: "utf8" });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("check-no-nul runner: an unscannable tracked file is not a clean one (#1215)", () => {
  it("PASSES a clean tree", () => {
    const { status, output } = run(makeRepo());
    expect(status).toBe(0);
    expect(output).toContain("no NUL bytes");
  });

  it("FAILS on a tracked file containing a NUL", () => {
    const dir = makeRepo();
    trackNulFile(dir, "src/bad.ts");

    const { status, output } = run(dir);
    expect(status).toBe(1);
    expect(output).toContain("src/bad.ts:1");
  });

  /**
   * Identity, not content: the NUL file's bytes are never touched. Only the worktree
   * entry standing in its place changes, and the gate must not read that as clean.
   */
  it("FAILS when the offending file is a directory where the index records a blob", () => {
    const dir = makeRepo();
    trackNulFile(dir, "src/bad.ts");
    expect(run(dir).status).toBe(1);

    fs.rmSync(path.join(dir, "src", "bad.ts"));
    fs.mkdirSync(path.join(dir, "src", "bad.ts"));

    const { status, output } = run(dir);
    expect(status).toBe(1);
    expect(output).toContain("NOT scanned");
    expect(output).not.toContain("no NUL bytes");
  });

  it.skipIf(!MODE_BITS_ENFORCED)("FAILS when the offending file cannot be opened", () => {
    const dir = makeRepo();
    trackNulFile(dir, "src/bad.ts");
    const before = fs.readFileSync(path.join(dir, "src", "bad.ts"));

    fs.chmodSync(path.join(dir, "src", "bad.ts"), 0o000);
    const denied = run(dir);
    expect(denied.status).toBe(1);
    expect(denied.output).toContain("NOT scanned");

    // Restore: the same bytes, readable again, and the original NUL failure returns —
    // which is what proves the arm above measured readability and not the NUL.
    fs.chmodSync(path.join(dir, "src", "bad.ts"), 0o644);
    expect(fs.readFileSync(path.join(dir, "src", "bad.ts"))).toEqual(before);
    const restored = run(dir);
    expect(restored.status).toBe(1);
    expect(restored.output).toContain("src/bad.ts:1");
  });

  /**
   * The one state the original `catch` was reaching for, kept a skip: a path in the
   * index that is not checked out cannot contain anything. It is now reported rather
   * than counted as scanned.
   */
  it("PASSES when a tracked path is absent from the worktree, and says so", () => {
    const dir = makeRepo();
    trackNulFile(dir, "src/bad.ts");
    fs.rmSync(path.join(dir, "src", "bad.ts"));

    const { status, output } = run(dir);
    expect(status).toBe(0);
    expect(output).toContain("not present in this worktree");
  });

  /**
   * The over-block guard, and the shape this repository actually has: 14 tracked
   * symlinks under `.claude/skills/` point at directories. A gate that failed on any
   * read error would reject METIS itself.
   */
  it("PASSES a tracked symlink pointing at a directory", () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, "real"), { recursive: true });
    fs.writeFileSync(path.join(dir, "real", "SKILL.md"), "# Skill\n", "utf8");
    fs.symlinkSync("../real", path.join(dir, "src", "link"));
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });

    const { status, output } = run(dir);
    expect(status).toBe(0);
    expect(output).toContain("no NUL bytes");
  });

  /**
   * #1381. `git ls-files` enumerates the CURRENT DIRECTORY's subtree, so before the
   * anchor this gate reported "2363 tracked text files scanned, no NUL bytes" when run
   * from `server/` against a tree of 4363 — two thousand files unscanned, and a success
   * line indistinguishable from the honest one.
   *
   * The arm is built so the omission is the ONLY way it can pass differently: the
   * offending file sits at the repository root, the invocation happens two directories
   * down, and the assertion is on the offender's own path. Remove the `chdirToRepoRoot`
   * call in the runner and this goes from exit 1 to exit 0 while still printing "no NUL
   * bytes" — which is the defect, stated as a test.
   */
  it("scans the WHOLE repository when invoked from a subdirectory", () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, "server", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "server", "src", "fine.ts"), "export const a = 1;\n", "utf8");
    trackNulFile(dir, "bad.ts");

    const fromRoot = run(dir);
    const fromSub = run(path.join(dir, "server", "src"));

    expect(fromRoot.status).toBe(1);
    expect(fromSub.status).toBe(1);
    expect(fromSub.output).toContain("bad.ts:1");
    // Not just "also red": byte-identical, because a gate that finds the offender but
    // silently drops the neighbours is still lying about what it covered.
    expect(fromSub.output).toBe(fromRoot.output);
  });

  it("reports the same file count from the root and from a subdirectory", () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, "server"), { recursive: true });
    fs.writeFileSync(path.join(dir, "server", "a.ts"), "export const a = 1;\n", "utf8");
    fs.writeFileSync(path.join(dir, "top.md"), "# top\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });

    const fromRoot = run(dir);
    const fromSub = run(path.join(dir, "server"));

    expect(fromRoot.output).toContain("3 tracked text files scanned");
    expect(fromSub.output).toBe(fromRoot.output);
  });

  /**
   * #1381's second decision. The gate used to throw a raw `execFileSync` stack trace
   * outside a checkout — an exported source tarball has no `.git`, so `pnpm lint`
   * crashed instead of explaining. It now fails deliberately, because the tracked-file
   * set is UNKNOWN rather than empty, and says so in prose. The reasoning lives in
   * `repo-root.mjs`; that it is SHARED with the sibling gate is pinned in
   * `gate-cwd-anchoring.test.mjs`.
   */
  it("FAILS with an explanation, not a stack trace, outside a git checkout", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-no-nul-nogit-"));
    created.push(dir);
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1;\n", "utf8");

    const { status, output } = run(dir);

    expect(status).toBe(1);
    expect(output).toContain("check-no-nul: not a git checkout — NOTHING was scanned.");
    expect(output).not.toMatch(/^\s+at /m);
    expect(output).not.toContain("no NUL bytes");
  });

  it("counts only the files it actually opened", () => {
    const dir = makeRepo();
    fs.writeFileSync(path.join(dir, "src", "gone.ts"), "export const gone = 1;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "pipe" });
    const both = run(dir);
    expect(both.output).toContain("2 tracked text files scanned");

    fs.rmSync(path.join(dir, "src", "gone.ts"));
    const one = run(dir);
    expect(one.output).toContain("1 tracked text files scanned");
    expect(one.output).toContain("1 tracked path(s) not present");
  });
});
