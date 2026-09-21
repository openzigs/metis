import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Issues #1333 and #1382 — runner-level tests for the nightly eval-results commit
 * guard.
 *
 * ## Why these cannot be unit tests over the core
 *
 * The core takes `foundPaths` and a status map as input, so no test over it can
 * notice a runner that asks git the WRONG QUESTION — and asking the wrong
 * question is the entire defect. The shipped guard was
 * `git status --porcelain eval-results`, which omits ignored files; every arm
 * of a core unit test would pass against it unchanged.
 *
 * So the real script is spawned inside a throwaway git repository whose
 * `.gitignore` is the REPOSITORY'S OWN, copied verbatim, and whose `eval-results/`
 * is a worktree on an orphan `eval-results` branch — the shape #1382 moved the
 * nightly to. That makes these tests a ratchet on three things at once:
 *
 *  1. the guard's behaviour,
 *  2. the shipped ignore rule — `main` must ignore `eval-results/` outright, and the
 *     `skips the worktree checkout` arm goes red if a negation creeps back in, and
 *  3. the worktree wiring — `skips the worktree checkout` holds the guard constant
 *     and removes the branch checkout, proving the guard fails rather than reading
 *     a blanket-ignored directory as "nothing to do".
 */

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(scriptsDir);
const RUNNER = "eval-results-commit-guard.mjs";

/** The ignore rule the repository actually ships. */
const SHIPPED_GITIGNORE = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");

/** Files the eval writes that `main` must never track. */
const NIGHTLY_OUTPUTS = [
  "eval-results/2026-08-29T03-00-00-000Z.json",
  "eval-results/answer-correctness/2026-08-29T03-00-10-000Z.json",
];

/** @type {string} */
let fixture;

/** @param {string[]} args */
function git(args) {
  execFileSync("git", args, { cwd: fixture, stdio: "pipe" });
}

/** @param {string} relativePath @param {string} contents */
function write(relativePath, contents) {
  const target = path.join(fixture, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

function runGuard() {
  const result = spawnSync(process.execPath, [path.join(fixture, "scripts", RUNNER)], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** A minimal but schema-shaped domain envelope; the guard only reads the path. */
const ENVELOPE = `${JSON.stringify({ runId: "x", corpusF1: 0.5 }, null, 2)}\n`;

beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "metis-1333-"));
  fs.mkdirSync(path.join(fixture, "scripts"), { recursive: true });
  // Install the REAL runner and core — a stand-in could not regress.
  fs.copyFileSync(path.join(scriptsDir, RUNNER), path.join(fixture, "scripts", RUNNER));
  fs.cpSync(path.join(scriptsDir, "lib"), path.join(fixture, "scripts", "lib"), {
    recursive: true,
  });

  git(["init", "-q", "-b", "main", "."]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  write(".gitignore", SHIPPED_GITIGNORE);
  git(["add", "-f", ".gitignore"]);
  git(["commit", "-qm", "init"]);

  // #1382: the nightly's output directory is a worktree on an orphan branch.
  git(["worktree", "add", "--orphan", "-b", "eval-results", "eval-results"]);
  // A historical envelope on the branch — the accumulated drift history the
  // nightly compares against. It must never stand in for this run's output.
  write("eval-results/2026-07-21T03-00-00-000Z.json", ENVELOPE);
  execFileSync("git", ["add", "-A", "."], {
    cwd: path.join(fixture, "eval-results"),
    stdio: "pipe",
  });
  execFileSync("git", ["commit", "-qm", "history"], {
    cwd: path.join(fixture, "eval-results"),
    stdio: "pipe",
  });
});

afterEach(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

describe("eval-results commit guard", () => {
  it("passes, and names both paths, when the nightly writes both envelopes", () => {
    for (const out of NIGHTLY_OUTPUTS) write(out, ENVELOPE);

    const { status, output } = runGuard();
    expect(output).toContain("eval-results/2026-08-29T03-00-00-000Z.json");
    expect(output).toContain("eval-results/answer-correctness/2026-08-29T03-00-10-000Z.json");
    expect(status).toBe(0);
  });

  it("leaves the fresh envelopes addable by the BRANCH worktree's `git add`", () => {
    // The guard passing is worthless if the very next line of the workflow
    // cannot stage the files. This asserts the publish path, not the guard.
    for (const out of NIGHTLY_OUTPUTS) write(out, ENVELOPE);

    const worktree = path.join(fixture, "eval-results");
    execFileSync("git", ["add", "-A", "."], { cwd: worktree, stdio: "pipe" });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: worktree,
      encoding: "utf8",
    });
    expect(staged).toContain("2026-08-29T03-00-00-000Z.json");
    expect(staged).toContain("answer-correctness/2026-08-29T03-00-10-000Z.json");
  });

  it("FAILS when the workflow skips the `eval-results` branch checkout", () => {
    // Without the worktree, `eval-results/` is just a blanket-ignored directory in
    // the main checkout — the exact shape of #1333's five silent weeks. The guard
    // must say so rather than read it as nothing to do.
    git(["worktree", "remove", "--force", "eval-results"]);
    for (const out of NIGHTLY_OUTPUTS) write(out, ENVELOPE);

    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain("gitignored");
    expect(output).toContain("eval-results/2026-08-29T03-00-00-000Z.json");
    expect(output).toContain("::error");
  });

  it("FAILS when an ignore rule is added ON the eval-results branch", () => {
    write("eval-results/.gitignore", "*.json\n");
    for (const out of NIGHTLY_OUTPUTS) write(out, ENVELOPE);

    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain("gitignored");
  });

  it("FAILS when the eval wrote nothing, instead of reporting 'nothing to commit'", () => {
    const { status, output } = runGuard();
    expect(status).toBe(1);
    // The tracked 2026-07-21 envelope IS on disk. It must not stand in for a
    // fresh one — that is the shape that made five weeks of greens meaningless.
    expect(output).toContain("wrote nothing new");
    expect(output).not.toMatch(/No new domain eval results/);
  });

  it("FAILS when only the domain envelope landed and answer-correctness did not", () => {
    write(NIGHTLY_OUTPUTS[0], ENVELOPE);
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toContain("answer-correctness");
  });

  it("FAILS when the only new file is an ad-hoc artifact the nightly does not own", () => {
    write("eval-results/embed-retrieval-2026-08-29T00-00-00-000Z.json", ENVELOPE);
    const { status } = runGuard();
    expect(status).toBe(1);
  });

  it("passes when a previously committed envelope is rewritten rather than added", () => {
    write("eval-results/2026-07-21T03-00-00-000Z.json", `${ENVELOPE}\n`);
    write(NIGHTLY_OUTPUTS[1], ENVELOPE);
    const { status } = runGuard();
    expect(status).toBe(0);
  });

  it("writes its report to the GitHub step summary when one is configured", () => {
    for (const out of NIGHTLY_OUTPUTS) write(out, ENVELOPE);
    const summary = path.join(fixture, "summary.md");
    const result = spawnSync(process.execPath, [path.join(fixture, "scripts", RUNNER)], {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(summary, "utf8")).toContain("commit guard — OK");
  });

  it("FAILS rather than passing when git itself cannot answer", () => {
    // Not a git repository at all: an unreadable git state must never resolve
    // to "nothing to do".
    fs.rmSync(path.join(fixture, "eval-results", ".git"), { force: true });
    fs.rmSync(path.join(fixture, ".git"), { recursive: true, force: true });
    const { status, output } = runGuard();
    expect(status).toBe(1);
    expect(output).toMatch(/git status failed|not a git repository/i);
  });
});
