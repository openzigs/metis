import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Runner-level tests for the changelog fragment gate (Issue #1191).
 *
 * ## Why these cannot be unit tests over the core
 *
 * Two of the runner's decisions are its own, and both are the fail-open shape
 * this repository keeps getting bitten by (#1168's `skillFiles` default, #1178's
 * four-headings round trip, #1180's two fail-open paths):
 *
 *  1. **Which question it asks git.** The core takes `changedPaths` as input, so
 *     no test over it can notice a runner that computes the diff against the
 *     wrong ref — or against nothing at all.
 *  2. **What it does when the base ref is unresolvable.** A `catch { return [] }`
 *     there produces a gate that exits 0 on every branch, and every arm of a
 *     core unit test would still pass.
 *
 * So the real script is spawned in a throwaway git repository and mutated
 * between arms — a broken shape must FAIL and a good one must PASS, with the
 * surrounding tree held constant.
 */

const scriptsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNNER = "verify-changelog-fragment.mjs";

/** @type {string} */
let fixture;

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** @param {string} cwd @param {string[]} args @returns {number} */
function gitStatus(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status ?? -1;
}

/** @param {string} root @param {string} relativePath @param {string} contents */
function write(root, relativePath, contents) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

/**
 * Install the REAL runner and core into a fixture. A stand-in could not
 * regress, so the shipped files are copied verbatim.
 *
 * @param {string} root
 */
function installRunner(root) {
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(path.join(scriptsDir, RUNNER), path.join(root, "scripts", RUNNER));
  fs.cpSync(path.join(scriptsDir, "lib"), path.join(root, "scripts", "lib"), { recursive: true });
}

/** @param {string[]} [args] @param {Record<string,string>} [env] */
function runGate(args = [], env = {}) {
  const result = spawnSync(process.execPath, [path.join(fixture, "scripts", RUNNER), ...args], {
    cwd: fixture,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const GOOD_FRAGMENT = [
  "---",
  "issue: 4242",
  "section: Added",
  "---",
  "",
  "- A new thing.",
  "",
].join("\n");
const FRAGMENT_PATH = ".changes/unreleased/4242-a-new-thing.md";

describe("verify-changelog-fragment runner: the gate fails and passes by mutation", () => {
  beforeAll(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-fragment-runner-"));
    installRunner(fixture);
    write(fixture, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Legacy.\n");
    write(fixture, ".changes/README.md", "Fragments live here.\n");
    write(fixture, ".changes/unreleased/.gitkeep", "");

    git(fixture, ["init", "--quiet", "--initial-branch=main"]);
    git(fixture, ["config", "user.email", "probe@example.com"]);
    git(fixture, ["config", "user.name", "probe"]);
    git(fixture, ["add", "-A"]);
    git(fixture, ["commit", "--quiet", "-m", "base"]);
    // The runner resolves `origin/main`; a local remote-tracking ref is exactly
    // what a real clone has, without needing a network or a second repository.
    git(fixture, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  });

  afterAll(() => {
    if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
  });

  it("passes on an unchanged branch", () => {
    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("no fragment required");
  });

  it("FAILS once source changes with no fragment", () => {
    write(fixture, "server/src/thing.ts", "export const thing = 1;\n");
    git(fixture, ["add", "-A"]);
    git(fixture, ["commit", "--quiet", "-m", "change source"]);

    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("adds no changelog fragment");
    expect(output).toContain("server/src/thing.ts");
    expect(output).toContain(".changes/README.md");
  });

  it("PASSES once a well-formed fragment is added, source change intact", () => {
    write(fixture, FRAGMENT_PATH, GOOD_FRAGMENT);
    git(fixture, ["add", "-A"]);
    git(fixture, ["commit", "--quiet", "-m", "add fragment"]);

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("A changelog fragment is present");
    // The source change is still in the diff — the fragment is what changed the verdict.
    expect(fs.existsSync(path.join(fixture, "server", "src", "thing.ts"))).toBe(true);
  });

  it("FAILS when the fragment's section is mutated to an unknown value", () => {
    write(fixture, FRAGMENT_PATH, GOOD_FRAGMENT.replace("section: Added", "section: Improved"));
    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain('section is "Improved"');
  });

  it("FAILS when the fragment's issue stops matching its filename", () => {
    write(fixture, FRAGMENT_PATH, GOOD_FRAGMENT.replace("issue: 4242", "issue: 1188"));
    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("does not match the filename's 4242");
  });

  it("FAILS when the entry grows to the 7,786-character line that motivated the cap", () => {
    write(fixture, FRAGMENT_PATH, GOOD_FRAGMENT.replace("- A new thing.", `- ${"x".repeat(7784)}`));
    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("over the 500-character cap");
  });

  it("FAILS when the frontmatter is removed entirely", () => {
    write(fixture, FRAGMENT_PATH, "- A new thing.\n");
    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("no closed --- frontmatter block");
  });

  it("PASSES again once the fragment is restored — the mutations were the cause", () => {
    write(fixture, FRAGMENT_PATH, GOOD_FRAGMENT);
    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("A changelog fragment is present");
  });

  it("does NOT demand a fragment for an exempt-only change", () => {
    // The restore above returned the fragment to its committed bytes, so the
    // tree is clean and this branch starts from the base with nothing carried over.
    git(fixture, ["checkout", "--quiet", "-b", "docs-only", "refs/remotes/origin/main"]);
    write(fixture, "docs/ARCHITECTURE.md", "# Architecture\n\nA docs-only edit.\n");
    git(fixture, ["add", "-A"]);
    git(fixture, ["commit", "--quiet", "-m", "docs only"]);

    const { status, output } = runGate();
    expect(status).toBe(0);
    expect(output).toContain("no fragment required");
  });

  it("sees an UNCOMMITTED source change, so a local pre-push run is honest", () => {
    write(fixture, "ui/app/page.tsx", "export default function Page() { return null; }\n");
    const { status, output } = runGate();
    expect(status).toBe(1);
    expect(output).toContain("ui/app/page.tsx");
    fs.rmSync(path.join(fixture, "ui"), { recursive: true, force: true });
  });

  it("FAILS CLOSED when the base ref cannot be resolved", () => {
    const { status, output } = runGate(["--base", "refs/heads/no-such-branch"]);
    expect(status).toBe(1);
    expect(output).toContain("could not resolve a base ref");
    // The distinguishing assertion: it must not have reported success.
    expect(output).not.toContain("no fragment required");
  });

  it("honours an explicit --base and $CHANGELOG_BASE_REF", () => {
    expect(runGate(["--base", "refs/remotes/origin/main"]).status).toBe(0);
    expect(runGate([], { CHANGELOG_BASE_REF: "refs/remotes/origin/main" }).status).toBe(0);
  });
});

/**
 * Identity arms: WHICH file counts as a fragment.
 *
 * The describe above mutates what is *inside* a fragment thoroughly and never
 * mutates *which file counts as one* — and that is exactly where three bypasses
 * lived. All three exited 0 against the first implementation, because "fragments
 * this branch added" was derived from the changed-path list while "what is
 * valid" was parsed from disk, and the two filters disagreed:
 *
 *  - **A dotfile.** `.sneaky.md` was named in the diff and counted, but the disk
 *    reader skips dotfiles, so nothing ever parsed it. The gate printed its own
 *    contradiction — "1 fragment(s) on this branch, 0 fragment(s) in
 *    .changes/unreleased/" — and passed.
 *  - **Editing someone else's fragment.** Fragments accumulate until a release,
 *    so the steady state is a directory full of other people's entries. A
 *    one-word typo fix counted as a contribution. No malice required.
 *  - **Deleting one.** `git diff --name-only` lists deletions, so removing
 *    another PR's fragment and adding nothing satisfied the gate.
 *
 * Each arm therefore fails, and the tree is restored between them so the failure
 * is attributable to the mutation rather than to leftover state.
 */
describe("verify-changelog-fragment runner: which file COUNTS as a fragment", () => {
  /** @type {string} */
  let root;

  const OTHERS = ".changes/unreleased/900-someone-elses-entry.md";
  const OTHERS_TEXT = ["---", "issue: 900", "section: Fixed", "---", "", "- Their entry.", ""].join(
    "\n",
  );
  const MINE = ".changes/unreleased/4243-my-entry.md";
  const MINE_TEXT = ["---", "issue: 4243", "section: Added", "---", "", "- My entry.", ""].join(
    "\n",
  );

  /** @param {string[]} [args] */
  function run(args = []) {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", RUNNER), ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-fragment-identity-"));
    installRunner(root);
    write(root, ".changes/unreleased/.gitkeep", "");
    // Already on main: another PR's fragment, merged and awaiting the next release.
    write(root, OTHERS, OTHERS_TEXT);
    git(root, ["init", "--quiet", "--initial-branch=main"]);
    git(root, ["config", "user.email", "probe@example.com"]);
    git(root, ["config", "user.name", "probe"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", "base with someone else's fragment"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    // The branch under test changes source, so it owes an entry.
    git(root, ["checkout", "--quiet", "-b", "feature"]);
    write(root, "server/src/thing.ts", "export const thing = 1;\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", "change source"]);
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** Return the tree to "source changed, no fragment of my own". */
  function restoreTree() {
    git(root, ["checkout", "--quiet", "--", "."]);
    git(root, ["clean", "--quiet", "-fd", ".changes"]);
  }

  it("BYPASS A — a dotfile in the fragment directory is not a fragment", () => {
    write(root, ".changes/unreleased/.sneaky.md", "total garbage, not a fragment at all\n");

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("adds no changelog fragment");
    // Named, not silently dropped: the author is told why the file was ignored.
    expect(output).toContain(".sneaky.md");
    expect(output).not.toContain("A changelog fragment is present");

    restoreTree();
  });

  it("BYPASS B — editing a fragment already on the base ref is not a contribution", () => {
    write(root, OTHERS, OTHERS_TEXT.replace("Their entry.", "Their entry, typo fixed."));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("adds no changelog fragment");
    expect(output).toContain("900-someone-elses-entry.md");
    expect(output).not.toContain("A changelog fragment is present");

    restoreTree();
  });

  it("BYPASS C — deleting someone else's fragment is not a contribution", () => {
    fs.rmSync(path.join(root, ...OTHERS.split("/")));

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("adds no changelog fragment");
    expect(output).not.toContain("A changelog fragment is present");

    restoreTree();
  });

  it("PASSES once the branch adds a fragment of its own — the arms above were the cause", () => {
    write(root, MINE, MINE_TEXT);

    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain("A changelog fragment is present");
  });

  it("still passes when a real fragment is added AND a pre-existing one is touched", () => {
    // The gate must not over-block: touching another fragment is irrelevant once
    // this branch has contributed one of its own.
    write(root, OTHERS, OTHERS_TEXT.replace("Their entry.", "Their entry, typo fixed."));

    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain("A changelog fragment is present");

    restoreTree();
  });
});

/**
 * The payoff, demonstrated rather than asserted: two concurrent branches adding
 * changelog entries must merge with no conflict.
 *
 * The control arm is the point. If the same scenario did NOT conflict without
 * fragments, the clean merge in the fragment arm would prove nothing — it would
 * just mean the scenario was never a collision.
 */
describe("two concurrent PRs adding changelog entries", () => {
  /** @type {string[]} */
  const roots = [];

  /**
   * A repo whose `CHANGELOG.md` has the append-at-one-anchor shape, optionally
   * with the `merge=union` stopgap committed at the base so both sides carry it.
   *
   * @param {{ unionDriver: boolean }} options
   */
  function makeRepo({ unionDriver }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-concurrency-"));
    roots.push(root);
    write(
      root,
      "CHANGELOG.md",
      "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Baseline entry.\n",
    );
    write(root, ".changes/unreleased/.gitkeep", "");
    write(
      root,
      ".gitattributes",
      `* text=auto eol=lf\n${unionDriver ? "CHANGELOG.md merge=union\n" : ""}`,
    );
    git(root, ["init", "--quiet", "--initial-branch=main"]);
    git(root, ["config", "user.email", "probe@example.com"]);
    git(root, ["config", "user.name", "probe"]);
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", "base"]);
    return root;
  }

  /** Insert a bullet at the shared anchor, exactly as an author appending would. */
  function appendEntry(root, text) {
    const file = path.join(root, "CHANGELOG.md");
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace("### Added\n\n", `### Added\n\n- ${text}\n`),
      "utf8",
    );
  }

  /**
   * Branch from main, apply `mutate`, commit, return to main.
   *
   * @param {string} root @param {string} branch @param {(root: string) => void} mutate
   */
  function branchWith(root, branch, mutate) {
    git(root, ["checkout", "--quiet", "-b", branch, "main"]);
    mutate(root);
    git(root, ["add", "-A"]);
    git(root, ["commit", "--quiet", "-m", branch]);
    git(root, ["checkout", "--quiet", "main"]);
  }

  /** @returns {number} 0 when the merge was clean */
  function mergeInto(root, branch) {
    return gitStatus(root, ["merge", "--no-ff", "--no-edit", "-m", `merge ${branch}`, branch]);
  }

  afterAll(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  });

  it("CONTROL: both editing CHANGELOG.md at one anchor DOES conflict", () => {
    const root = makeRepo({ unionDriver: false });
    branchWith(root, "pr-a", (r) => appendEntry(r, "Entry from PR A."));
    branchWith(root, "pr-b", (r) => appendEntry(r, "Entry from PR B."));

    expect(mergeInto(root, "pr-b")).toBe(0);
    expect(mergeInto(root, "pr-a")).not.toBe(0);
    // Unmerged index entries are the machine-readable proof of a real conflict.
    expect(execFileSync("git", ["ls-files", "-u"], { cwd: root, encoding: "utf8" })).toContain(
      "CHANGELOG.md",
    );
  });

  it("STOPGAP: merge=union resolves that same collision LOCALLY, keeping both sides", () => {
    const root = makeRepo({ unionDriver: true });
    branchWith(root, "pr-a", (r) => appendEntry(r, "Entry from PR A."));
    branchWith(root, "pr-b", (r) => appendEntry(r, "Entry from PR B."));

    expect(mergeInto(root, "pr-b")).toBe(0);
    expect(mergeInto(root, "pr-a")).toBe(0);

    const merged = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
    expect(merged).toContain("- Entry from PR A.");
    expect(merged).toContain("- Entry from PR B.");
    expect(merged).not.toContain("<<<<<<<");
  });

  it("FIX: two PRs adding fragments merge with no conflict, and CHANGELOG.md is untouched", () => {
    const root = makeRepo({ unionDriver: false });
    const before = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

    branchWith(root, "pr-a", (r) =>
      write(
        r,
        ".changes/unreleased/9001-thing-a.md",
        "---\nissue: 9001\nsection: Added\n---\n\n- Thing A.\n",
      ),
    );
    branchWith(root, "pr-b", (r) =>
      write(
        r,
        ".changes/unreleased/9002-thing-b.md",
        "---\nissue: 9002\nsection: Fixed\n---\n\n- Thing B.\n",
      ),
    );

    expect(mergeInto(root, "pr-b")).toBe(0);
    expect(mergeInto(root, "pr-a")).toBe(0);
    expect(execFileSync("git", ["ls-files", "-u"], { cwd: root, encoding: "utf8" }).trim()).toBe(
      "",
    );

    expect(fs.existsSync(path.join(root, ".changes/unreleased/9001-thing-a.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".changes/unreleased/9002-thing-b.md"))).toBe(true);
    // Neither branch touched the shared file, which is why there was nothing to collide on.
    expect(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(before);
  });
});

/**
 * An unlistable fragment directory is UNKNOWN, not "no fragments" (Issue #1215).
 *
 * ## What reading missed
 *
 * `readFragments()` ended `catch { return files; }`, and that looks safe because the
 * gate's headline rule is cross-checked against the diff: an empty map still fails a
 * branch that needed an entry, since the fragment it added is then "not on disk".
 *
 * But `verifyChangelogFragments` does **two** jobs, and only the first is
 * cross-checked. The second — parse *every* fragment on disk — has no diff to
 * disagree with, so on an empty map it simply does not run. A branch touching only
 * exempt paths therefore sails past a malformed fragment that the identical readable
 * tree rejects with four problems.
 *
 * Both arms below mutate **identity, not content**: the fragment's bytes are never
 * touched, only whether `.changes/unreleased/` is still a directory. #1192's matrix
 * missed three bypasses for exactly that reason.
 */
describe("verify-changelog-fragment runner: an unlistable fragment directory fails closed (#1215)", () => {
  const BROKEN = ".changes/unreleased/999-broken.md";
  const BROKEN_BYTES = "---\nissue: notanumber\n---\nbroken\n";

  /** @type {string} */
  let repo;

  /** @param {string[]} args */
  function run(args = []) {
    const result = spawnSync(process.execPath, [path.join(repo, "scripts", RUNNER), ...args], {
      cwd: repo,
      encoding: "utf8",
    });
    return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  /** @param {string} relativePath */
  function abs(relativePath) {
    return path.join(repo, ...relativePath.split("/"));
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-unlistable-"));
    installRunner(repo);
    write(repo, "CHANGELOG.md", "# Changelog\n");
    write(repo, ".changes/README.md", "Fragments live here.\n");
    write(repo, ".changes/unreleased/.gitkeep", "");
    // `docs/` is exempt, so nothing on this branch REQUIRES a fragment. That is
    // what isolates the "every fragment parses" half of the gate.
    write(repo, "docs/GUIDE.md", "docs\n");

    git(repo, ["init", "--quiet", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "probe@example.com"]);
    git(repo, ["config", "user.name", "probe"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", "base"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    write(repo, "docs/GUIDE.md", "docs\nmore docs\n");
    write(repo, BROKEN, BROKEN_BYTES);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", "exempt change plus a malformed fragment"]);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it("FAILS on the readable tree — the malformed fragment is parsed and rejected", () => {
    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("0 requiring an entry");
    expect(output).toContain(`${BROKEN}: frontmatter is missing "section"`);
  });

  it("FAILS when .changes/unreleased/ is not a directory — not 'no fragments'", () => {
    const bytes = fs.readFileSync(abs(BROKEN), "utf8");
    fs.rmSync(abs(".changes/unreleased"), { recursive: true, force: true });
    fs.writeFileSync(abs(".changes/unreleased"), "not a directory", "utf8");

    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("cannot list .changes/unreleased/");
    // The pre-fix behaviour, asserted so a regression is unmistakable.
    expect(output).not.toContain("no fragment required");

    // Restore: same bytes, back under a real directory.
    fs.rmSync(abs(".changes/unreleased"));
    write(repo, ".changes/unreleased/.gitkeep", "");
    write(repo, BROKEN, bytes);
    expect(fs.readFileSync(abs(BROKEN), "utf8")).toBe(BROKEN_BYTES);

    const restored = run();
    expect(restored.status).toBe(1);
    expect(restored.output).toContain(`${BROKEN}: frontmatter is missing "section"`);
  });

  it("PASSES with the directory genuinely ABSENT — ENOENT is a knowable answer", () => {
    fs.rmSync(abs(".changes/unreleased"), { recursive: true, force: true });

    const { status, output } = run();
    expect(status).toBe(0);
    expect(output).toContain("no fragment required");
  });
});

/**
 * The automated-dependency-author exemption, proven in BOTH directions (#1270).
 *
 * ## What was broken
 *
 * Dependabot has no step in which it could write a fragment, so the gate did not
 * enforce a standard on it — it parked every one of its PRs forever. All ten
 * open on 2026-08-06 failed `changelog`, the oldest since 2026-08-02. A rule no
 * author in a class can satisfy produces a permanently-red check, which carries
 * exactly as much information as one nobody runs (#1219).
 *
 * ## Why every arm here is a PAIR
 *
 * A one-directional test is half a gate: "the bot passes" is equally satisfied
 * by exempting the manifests for everyone, which is #1270's option 1 and the
 * lossy one — #1240 and #1241 each moved CVSS 7.0+ advisories by hand and each
 * wrote an entry worth having. So every arm holds the TREE constant and mutates
 * only the author, and the tree used is the union of the real file lists of all
 * ten PRs, captured verbatim from `gh pr view --json files` rather than written
 * by hand (#1249).
 */
describe("verify-changelog-fragment runner: the dependabot author exemption (#1270)", () => {
  /**
   * @type {{ capturedAt: string, prs: Record<string, { author: string, title: string, files: string[] }> }}
   */
  const corpus = JSON.parse(
    fs.readFileSync(path.join(scriptsDir, "lib", "fixtures", "dependabot-pr-files.json"), "utf8"),
  );

  /** Every path any of the ten PRs touches. */
  const realPaths = [...new Set(Object.values(corpus.prs).flatMap((pr) => pr.files))].sort();

  const BOT = "dependabot[bot]";

  /** @type {string} */
  let repo;

  /** @param {string[]} [args] @param {Record<string,string>} [env] */
  function run(args = [], env = {}) {
    const result = spawnSync(process.execPath, [path.join(repo, "scripts", RUNNER), ...args], {
      cwd: repo,
      encoding: "utf8",
      // `CHANGELOG_PR_AUTHOR` must not leak in from the developer's shell.
      env: { ...process.env, CHANGELOG_PR_AUTHOR: "", ...env },
    });
    return { status: result.status ?? -1, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  }

  /** @param {string} relativePath */
  function abs(relativePath) {
    return path.join(repo, ...relativePath.split("/"));
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-dependabot-"));
    installRunner(repo);
    write(repo, "CHANGELOG.md", "# Changelog\n");
    write(repo, ".changes/README.md", "Fragments live here.\n");
    write(repo, ".changes/unreleased/.gitkeep", "");
    for (const filePath of realPaths) write(repo, filePath, "{}\n");

    git(repo, ["init", "--quiet", "--initial-branch=main"]);
    git(repo, ["config", "user.email", "probe@example.com"]);
    git(repo, ["config", "user.name", "probe"]);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", "base"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    // The bump: every real path edited, no fragment. Exactly the shape of the
    // ten PRs, and the shape that was red.
    git(repo, ["checkout", "--quiet", "-b", "dependabot/npm_and_yarn/all"]);
    for (const filePath of realPaths) write(repo, filePath, '{"bumped": true}\n');
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", "chore(deps): bump everything"]);
  });

  afterAll(() => {
    if (repo) fs.rmSync(repo, { recursive: true, force: true });
  });

  it("the corpus really is the ten PRs, and the tree really is their union", () => {
    expect(Object.keys(corpus.prs)).toHaveLength(10);
    expect(realPaths).toContain("pnpm-lock.yaml");
    expect(realPaths).toContain("ui/package.json");
    expect(realPaths).toContain(".github/workflows/ci.yml");
    for (const filePath of realPaths) expect(fs.existsSync(abs(filePath))).toBe(true);
  });

  it("BEFORE the author is supplied: the identical tree FAILS — the defect, reproduced", () => {
    const { status, output } = run();
    expect(status).toBe(1);
    expect(output).toContain("adds no changelog fragment");
    expect(output).toContain("author=(unknown — strict)");
  });

  it("DIRECTION 1 — the same tree PASSES with --author dependabot[bot], no fragment", () => {
    const { status, output } = run(["--author", BOT]);
    expect(status).toBe(0);
    expect(output).toContain("no fragment required");
    // The waiver is NAMED, not silent: a skip nobody can see in the log is one
    // nobody notices when it fires wrongly.
    expect(output).toContain("exempt because dependabot[bot] is an automated dependency author");
    expect(output).toContain("ui/package.json");
  });

  it("DIRECTION 1 — the gh spelling app/dependabot works too", () => {
    expect(run(["--author", "app/dependabot"]).status).toBe(0);
  });

  it("DIRECTION 1 — CHANGELOG_PR_AUTHOR is the path CI actually uses", () => {
    const { status, output } = run([], { CHANGELOG_PR_AUTHOR: BOT });
    expect(status).toBe(0);
    expect(output).toContain(`author=${BOT}`);
  });

  it("DIRECTION 2 — a HUMAN touching the very same paths still FAILS", () => {
    const { status, output } = run(["--author", "mcronin"]);
    expect(status).toBe(1);
    expect(output).toContain("adds no changelog fragment");
    expect(output).toContain("author=mcronin");
    // Not the bot's message: a human is told to write the entry, full stop.
    expect(output).not.toContain("DEPENDENCY_MANIFEST_RULES");
  });

  it.each([
    ["dependabot", "the bare login, which a human account could take"],
    ["dependabot-mirror", "a login a substring test would admit"],
    ["not-dependabot[bot]", "a login a substring test would admit"],
    ["renovate[bot]", "a different bot, not configured here"],
  ])("DIRECTION 2 — %j FAILS (%s)", (author) => {
    const { status } = run(["--author", author]);
    expect(status).toBe(1);
  });

  it("DIRECTION 2 — an EMPTY author fails, which is what a push to main sends", () => {
    // `${{ github.event.pull_request.user.login }}` expands to "" on `push` and
    // `workflow_dispatch`. If empty read as "a bot", the gate would be off for
    // every non-PR run, which is the fail-open this change must not introduce.
    expect(run([], { CHANGELOG_PR_AUTHOR: "" }).status).toBe(1);
    expect(run([], { CHANGELOG_PR_AUTHOR: "   " }).status).toBe(1);
    expect(run(["--author"]).status).toBe(1);
  });

  it("RESTORE — back to the bot author, the same tree passes again", () => {
    // The author was the cause: nothing else moved across any arm above.
    const { status, output } = run(["--author", BOT]);
    expect(status).toBe(0);
    expect(output).toContain("no fragment required");
  });

  it("a bot PR that also edits SOURCE fails, and is told where to widen the rule", () => {
    write(repo, "server/src/lib/db.ts", "export const db = 1;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", "bot touches source"]);

    const { status, output } = run(["--author", BOT]);
    expect(status).toBe(1);
    expect(output).toContain("server/src/lib/db.ts");
    expect(output).toContain("exempt on dependency manifests only");
    expect(output).toContain("DEPENDENCY_MANIFEST_RULES");

    git(repo, ["reset", "--quiet", "--hard", "HEAD~1"]);
    expect(run(["--author", BOT]).status).toBe(0);
  });

  it("the exemption does NOT swallow a malformed fragment on disk", () => {
    // The gate's OTHER half — parse every fragment present — is untouched by the
    // author. Short-circuiting it would be #1215's fail-open by a different door.
    write(repo, ".changes/unreleased/999-broken.md", "---\nissue: notanumber\n---\nbroken\n");

    const { status, output } = run(["--author", BOT]);
    expect(status).toBe(1);
    expect(output).toContain("0 requiring an entry");
    expect(output).toContain('frontmatter is missing "section"');

    fs.rmSync(abs(".changes/unreleased/999-broken.md"));
    expect(run(["--author", BOT]).status).toBe(0);
  });

  it("the exemption does NOT swallow an UNLISTABLE fragment directory (#1215)", () => {
    // Identity, not content: the directory's contents are never edited, only
    // whether it is still a directory. An exemption that reported success on an
    // input it could not read is the defect #1215 already fixed once here.
    fs.rmSync(abs(".changes/unreleased"), { recursive: true, force: true });
    fs.writeFileSync(abs(".changes/unreleased"), "not a directory", "utf8");

    const { status, output } = run(["--author", BOT]);
    expect(status).toBe(1);
    expect(output).toContain("cannot list .changes/unreleased/");
    expect(output).not.toContain("no fragment required");

    fs.rmSync(abs(".changes/unreleased"));
    write(repo, ".changes/unreleased/.gitkeep", "");
    expect(run(["--author", BOT]).status).toBe(0);
  });

  it("FAILS CLOSED on an unresolvable base ref even for the bot", () => {
    const { status, output } = run(["--author", BOT, "--base", "refs/heads/no-such-branch"]);
    expect(status).toBe(1);
    expect(output).toContain("could not resolve a base ref");
    expect(output).not.toContain("no fragment required");
  });

  /**
   * The wiring, asserted against the REAL workflow file.
   *
   * Raised by the `test-falsifiability` voter on this change and fixed rather
   * than answered: every arm above supplies the author itself, so deleting the
   * `env:` block from `.github/workflows/ci.yml` — or mistyping the expression
   * as `github.event.pull_request.author.login`, which expands to the empty
   * string rather than erroring — left the whole suite green while all ten
   * dependabot PRs stayed red. The gate's script was proven and its only
   * production caller was not.
   *
   * Both halves are read out of the workflow rather than restated here, and the
   * VARIABLE NAME is then fed to the real runner, so a rename on either side of
   * the seam breaks this. Same approach `sast-waiver-gate.test.mjs` takes to the
   * OSV threshold: extract from the shipped file, do not duplicate it.
   */
  describe("the CI wiring that supplies the author", () => {
    const workflow = fs.readFileSync(
      path.join(path.dirname(scriptsDir), ".github", "workflows", "ci.yml"),
      "utf8",
    );

    /** The `changelog:` job block, sliced at the next job's two-space key. */
    const job = (() => {
      const lines = workflow.split("\n");
      const start = lines.findIndex((line) => /^ {2}changelog:\s*$/.test(line));
      expect(start).toBeGreaterThanOrEqual(0);
      const after = lines.findIndex((line, i) => i > start && /^ {2}\S.*:\s*$/.test(line));
      return lines.slice(start, after >= 0 ? after : lines.length).join("\n");
    })();

    it("the changelog job still runs the verifier this file tests", () => {
      expect(job).toContain(`node scripts/${RUNNER}`);
      // `fetch-depth: 0` is what gives the job an `origin/main` to diff against;
      // without it the runner fails closed and the exemption never gets asked.
      expect(job).toContain("fetch-depth: 0");
    });

    it("passes the PR author from the event payload, not from the branch", () => {
      const match = /\n\s+(CHANGELOG_[A-Z_]+):\s*(\$\{\{[^}]*\}\})/.exec(job);
      expect(match).not.toBeNull();
      const [, variable, expression] = /** @type {RegExpExecArray} */ (match);

      // `user.login` is the PR's author. `github.actor` would be whoever last
      // re-ran the job, and `pull_request.author.login` does not exist — it
      // expands to "", which reads as unknown and quietly reverts the fix.
      expect(expression.replace(/\s+/g, " ")).toBe("${{ github.event.pull_request.user.login }}");
      expect(variable).toBe("CHANGELOG_PR_AUTHOR");
    });

    it("the variable the workflow sets is the one the runner reads", () => {
      // Lifted from the workflow, not typed again: rename it in ci.yml alone and
      // this arm goes red instead of the gate silently reverting to strict.
      const variable = /\n\s+(CHANGELOG_PR_[A-Z_]+):/.exec(job)?.[1];
      expect(variable).toBeTruthy();

      const asBot = run([], { [String(variable)]: BOT });
      expect(asBot.status).toBe(0);
      expect(asBot.output).toContain(`author=${BOT}`);

      // And the empty expansion a `push` or a mistyped expression produces is
      // the strict reading, on the same variable.
      expect(run([], { [String(variable)]: "" }).status).toBe(1);
    });
  });
});
