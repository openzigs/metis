#!/usr/bin/env node
/**
 * `pnpm changelog:verify` — assert that a branch changing source also adds a
 * changelog fragment, and that every fragment on disk parses (Issue #1191).
 *
 * Thin I/O glue only: it resolves the base ref, gathers the changed paths and
 * the fragment contents, then hands them to the pure logic in
 * `lib/changelog-fragments-core.mjs`, which is where the rules and their
 * reasoning live.
 *
 * Usage:
 *   node scripts/verify-changelog-fragment.mjs [--base <ref>] [--author <login>]
 *   CHANGELOG_BASE_REF=<ref> CHANGELOG_PR_AUTHOR=<login> node scripts/…
 *
 * Exit codes:
 *   0  every fragment parses, and either a fragment was added or nothing
 *      non-exempt changed
 *   1  a malformed fragment, a missing fragment, or an unresolvable base ref
 *
 * The base ref is resolved rather than assumed, and an unresolvable base is a
 * FAILURE, not a skip. A gate that silently passes when it cannot find its
 * comparison point is the fail-open shape #1168 and #1180 were both filed
 * against; here it would mean every PR from a shallow clone quietly escaped the
 * check while the job stayed green.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FRAGMENT_DIR,
  isAutomatedDependencyAuthor,
  isFragmentBasename,
  verifyChangelogFragments,
} from "./lib/changelog-fragments-core.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `execFileSync` lets git's stderr through to ours unless it is piped, so the
 * calls whose failure is EXPECTED and handled pipe it — otherwise a base ref
 * with no fragment directory prints a red `fatal:` line above a passing run.
 *
 * @param {string[]} args
 * @param {{ quiet?: boolean }} [options]
 * @returns {string}
 */
function git(args, { quiet = false } = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "pipe"] : undefined,
  });
}

/** @param {string} ref @returns {boolean} */
function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the ref this branch is measured against.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
function resolveBase(argv) {
  const flagIndex = argv.indexOf("--base");
  const explicit =
    (flagIndex >= 0 ? argv[flagIndex + 1] : undefined) ?? process.env.CHANGELOG_BASE_REF;
  if (explicit) return refExists(explicit) ? explicit : null;

  for (const candidate of ["origin/main", "main"]) {
    if (refExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the PR author, which decides whether the dependency-manifest
 * exemption applies (#1270).
 *
 * CI passes `github.event.pull_request.user.login` from the `pull_request`
 * event, which GitHub populates from the PR record — nothing in the branch's
 * contents can change it. A branch CAN of course edit the workflow that sets it,
 * because `pull_request` runs the head ref's workflow file; that is not a new
 * weakness, since the same edit could delete this job outright, and `main`
 * carries no required status checks either way. This gate is a discipline
 * mechanism against forgetting, not an integrity boundary against an author who
 * controls CI.
 *
 * The absent case is the STRICT one: no flag, no env var, or an empty string —
 * a push to `main`, a `workflow_dispatch`, or any local run — yields `null` and
 * every path keeps requiring an entry. A default that meant "assume a bot" would
 * be the fail-open this whole family of gates keeps being audited for.
 *
 * @param {string[]} argv
 * @returns {string | null}
 */
function resolveAuthor(argv) {
  const flagIndex = argv.indexOf("--author");
  const raw = (flagIndex >= 0 ? argv[flagIndex + 1] : undefined) ?? process.env.CHANGELOG_PR_AUTHOR;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Paths this branch touches: everything since the merge base, plus anything
 * still uncommitted so a local pre-push run sees the fragment the author just
 * wrote. In CI the working tree is clean and the second half contributes
 * nothing.
 *
 * @param {string} base
 * @returns {string[]}
 */
function changedPaths(base) {
  const paths = new Set();

  for (const line of git(["diff", "--name-only", `${base}...HEAD`]).split("\n")) {
    if (line.trim().length > 0) paths.add(line.trim());
  }
  // `-z` would be safer for exotic names, but the porcelain rename form
  // ("R  old -> new") needs splitting anyway and this repo has no such paths.
  for (const line of git(["status", "--porcelain", "--untracked-files=all"]).split("\n")) {
    const entry = line.slice(3).trim();
    if (entry.length === 0) continue;
    const arrow = entry.lastIndexOf(" -> ");
    paths.add(arrow >= 0 ? entry.slice(arrow + 4) : entry);
  }

  return [...paths];
}

/**
 * Every fragment on disk, keyed by basename.
 *
 * The filter is `isFragmentBasename` — the SAME function the diff side uses.
 * When these two were separate lists they drifted over dotfiles, and a path
 * could count as "a fragment this branch added" while never being read here.
 *
 * **An unreadable directory throws rather than yielding nothing (#1215).** The
 * `catch { return files }` here was a fail-open, and it hid the gate's *other*
 * half. `verifyChangelogFragments` does two jobs: it asks whether this branch
 * contributed a fragment, and it parses **every** fragment on disk. Only the
 * first is cross-checked against the diff, so an empty map still fails a branch
 * that needed an entry — but the second job simply stops running. Measured on
 * the real runner: a branch touching only `docs/` with a malformed fragment on
 * disk exits **1** and names four parse problems; replace `.changes/unreleased/`
 * with a plain file, changing nothing else, and it exits **0** printing "no
 * fragment required"; restore the directory and the same four problems return.
 *
 * A per-file read failure is deliberately left as `null`, because that IS
 * checked — `parseFragment(name, null)` reports "missing or unreadable" and the
 * gate exits 1. Only the enumeration had no such backstop.
 *
 * `ENOENT` stays tolerated: a base or branch with no fragment directory has no
 * fragments, which is a knowable answer rather than an unreadable one. Same line
 * `readMemoryStores` draws in `verify-agent-frontmatter.mjs`.
 *
 * @returns {Record<string, string | null>}
 * @throws when the fragment directory exists but cannot be listed
 */
function readFragments() {
  const dir = path.join(repoRoot, ...FRAGMENT_DIR.split("/"));
  /** @type {Record<string, string | null>} */
  const files = {};
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return files;
    throw error;
  }
  for (const name of names) {
    if (!isFragmentBasename(name)) continue;
    try {
      files[name] = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      files[name] = null;
    }
  }
  return files;
}

/**
 * Fragment basenames already present at the base ref.
 *
 * This is what makes "added by this branch" mean added: a fragment that is
 * already on the base belongs to a PR that already merged, and fragments
 * accumulate here until a release, so at any time there are plenty to touch.
 * Reading the base TREE rather than parsing `git diff` status letters answers
 * the question directly and has no rename-detection or staged-vs-worktree
 * ambiguity to get wrong.
 *
 * A base ref with no fragment directory yields none, which is the truth: on
 * such a base nothing pre-exists. The base ref itself is already proven
 * resolvable by `resolveBase`, so this cannot swallow a missing-ref failure.
 *
 * @param {string} base
 * @returns {string[]}
 */
function baseFragmentNames(base) {
  let listing = "";
  try {
    listing = git(["ls-tree", "--name-only", `${base}:${FRAGMENT_DIR}`], { quiet: true });
  } catch {
    return [];
  }
  return listing
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => isFragmentBasename(name));
}

function main() {
  const argv = process.argv.slice(2);
  const base = resolveBase(argv);
  const author = resolveAuthor(argv);
  if (base === null) {
    console.error(
      "Changelog fragment check FAILED: could not resolve a base ref.\n" +
        "  Tried --base, $CHANGELOG_BASE_REF, origin/main, main.\n" +
        "  A shallow clone has no origin/main; fetch it or pass --base <ref>.\n" +
        "  This is a failure rather than a skip on purpose — a gate that cannot\n" +
        "  find its comparison point must not report success.",
    );
    process.exit(1);
  }

  const paths = changedPaths(base);

  /** @type {Record<string, string | null>} */
  let fragmentFiles;
  try {
    fragmentFiles = readFragments();
  } catch (error) {
    console.error(
      `Changelog fragment check FAILED: cannot list ${FRAGMENT_DIR}/: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    console.error(
      "  A fragment directory that cannot be read is not a directory with no fragments in it.\n" +
        "  Half this gate parses EVERY fragment on disk, and that half cannot run on an empty\n" +
        "  listing, so reporting success here would let a malformed fragment through (#1215).",
    );
    process.exit(1);
  }

  const report = verifyChangelogFragments({
    changedPaths: paths,
    fragmentFiles,
    baseFragments: baseFragmentNames(base),
    author,
  });

  // `contributed` is the number that decides the verdict, so it is the number
  // reported. The first version printed only "N fragment(s) on this branch",
  // which could read 1 while the gate had validated nothing at all.
  console.log(
    `Changelog fragments: base=${base}, author=${author ?? "(unknown — strict)"}, ` +
      `${paths.length} changed path(s), ` +
      `${report.requiring.length} requiring an entry, ${report.contributed.length} contributed by this branch ` +
      `(of ${report.addedFragments.length} touched), ${report.parsed.length} fragment(s) in ${FRAGMENT_DIR}/.`,
  );

  // Printed, not merely counted. An exemption that fires silently is one nobody
  // notices when it fires wrongly, so every path waived on the author's behalf
  // is named in the log of the run that waived it (#1270).
  if (report.authorExempt.length > 0) {
    console.log(
      `  ${report.authorExempt.length} path(s) exempt because ${author} is an automated dependency author\n` +
        `  and cannot write a fragment; a human changing these still owes one:\n` +
        report.authorExempt.map((p) => `    ${p}`).join("\n"),
    );
  } else if (isAutomatedDependencyAuthor(author)) {
    console.log(
      `  Author ${author} is an automated dependency author; no path needed the exemption.`,
    );
  }

  if (!report.ok) {
    console.error("\nChangelog fragment check FAILED:");
    for (const problem of report.problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  console.log(
    report.requiring.length === 0
      ? "\nNothing outside the exempt paths changed — no fragment required."
      : "\nA changelog fragment is present and every fragment parses.",
  );
}

main();
