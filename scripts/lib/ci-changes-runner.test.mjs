import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * #844 — the runner, spawned for real against a scratch git repository, because
 * its fail-open branches are exactly where a gate like this goes wrong and v8
 * coverage of this process cannot see a child.
 */

const runner = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ci-changes.mjs");

/** @type {string} */
let repo;

/** @param {string[]} args */
const git = (args) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });

/** @param {string} rel @param {string} body */
const write = (rel, body) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), body);
};

/** Builds base <- PR commit, and a merge commit of the PR onto base (as checkout does). */
function mergeCommitTouching(/** @type {string[]} */ files) {
  git(["checkout", "-q", "-b", "pr"]);
  for (const f of files) write(f, "changed\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "pr"]);
  git(["checkout", "-q", "main"]);
  write("base-moved.txt", "x\n"); // the base moved on: must NOT show up as a PR change
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  git(["merge", "-q", "--no-ff", "-m", "merge", "pr"]);
}

/** @param {Record<string, string>} env */
function run(env) {
  const out = path.join(repo, "..", `out-${path.basename(repo)}`);
  const summary = `${out}.md`;
  const res = spawnSync(process.execPath, [runner], {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: summary,
      ...env,
    },
  });
  const read = (/** @type {string} */ p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
  return { status: res.status, stdout: res.stdout, output: read(out), summary: read(summary) };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ci-changes-"));
  git(["init", "-q", "-b", "main"]);
  write("README.md", "base\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  const out = path.join(repo, "..", `out-${path.basename(repo)}`);
  for (const p of [repo, out, `${out}.md`]) fs.rmSync(p, { recursive: true, force: true });
});

describe("scripts/ci-changes.mjs (#844)", () => {
  it("skips both on a docs-only PR merge commit, and writes the summary", () => {
    mergeCommitTouching(["docs/a.md"]);
    const r = run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "feature/x" });
    expect(r.status).toBe(0);
    expect(r.output).toBe("postgres=false\nimages=false\n");
    expect(r.summary).toContain("**skipped**");
  });

  it("diffs against the merge's FIRST parent, so a base-side change is not the PR's", () => {
    mergeCommitTouching(["server/prisma/postgres/schema.prisma"]);
    const r = run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "feature/x" });
    expect(r.output).toBe("postgres=true\nimages=true\n");
    expect(r.stdout).toContain("1 changed path(s)");
    expect(r.stdout).not.toContain("base-moved.txt");
  });

  it("fails open when HEAD is not a merge commit", () => {
    write("docs/a.md", "x\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "linear"]);
    const r = run({ GITHUB_EVENT_NAME: "pull_request", GITHUB_HEAD_REF: "feature/x" });
    expect(r.status).toBe(0);
    expect(r.output).toBe("postgres=true\nimages=true\n");
    expect(r.stdout).toContain("not a merge commit");
  });

  it("fails open when git cannot read the repository at all", () => {
    fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
    const r = run({
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_HEAD_REF: "feature/x",
      GIT_CEILING_DIRECTORIES: path.dirname(repo),
    });
    expect(r.status).toBe(0);
    expect(r.output).toBe("postgres=true\nimages=true\n");
    expect(r.stdout).toContain("could not compute the changed paths");
  });

  it("runs everything on a push without looking at the diff", () => {
    const r = run({ GITHUB_EVENT_NAME: "push" });
    expect(r.output).toBe("postgres=true\nimages=true\n");
  });
});
