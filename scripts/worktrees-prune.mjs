#!/usr/bin/env node
/**
 * Prune stale agent git worktrees (Issue #916, hardened by Issue #986).
 *
 * Removes worktrees under `.claude/worktrees/agent-*` whose branch has merged into
 * `origin/main` or whose upstream is gone (squash-merge + `--delete-branch`), or
 * which are detached. The current worktree and the primary checkout are never
 * touched.
 *
 * Issue #986: the #916 heuristic could not distinguish an *active* agent
 * isolation worktree (on a local-only `worktree-agent-*` branch that never has
 * an upstream by design) from a genuinely abandoned one, and twice deleted
 * in-flight work. These safety rules now apply, in this precedence order (rule 4
 * was added later, by Issue #1147):
 *
 *   1. A `locked` worktree (`git worktree lock`) is NEVER pruned — no flag,
 *      not even `--force`, overrides this.
 *   2. A worktree on a `worktree-agent-*` branch with no upstream is skipped
 *      unless `--force` is passed — it is ephemeral-by-design, not stale.
 *   3. A worktree whose activity signal is recent (< 2h) is skipped unless
 *      `--force` is passed — presumed to have in-flight work. The signal is
 *      `max(root directory mtime, private gitdir file mtimes)` (Issue #992):
 *      root mtime alone only changes when a direct child is added/removed,
 *      so an agent editing nested files for hours looked idle; the gitdir's
 *      `index`/`HEAD`/`logs/HEAD` files are touched by any git operation and
 *      close that gap. An mtime that cannot be read at all (every probe
 *      fails, and the root failure is not `ENOENT`, i.e. the directory
 *      genuinely no longer exists) is treated the same way — kept, not
 *      pruned — so an I/O error fails SAFE.
 *   4. A worktree holding uncommitted or untracked files under
 *      `.claude/agent-memory/` is skipped unless `--force` is passed, and
 *      `--force` names the files it destroys (Issue #1147). Agent memory is the
 *      cross-session diagnosis channel and belongs in a commit, not in a
 *      throwaway worktree; one such file was nearly lost this way and had to be
 *      rescued by hand into PR #1140.
 *   5. Dry run is now the DEFAULT. Deleting requires an explicit `--yes` (or
 *      `--force`, which also overrides rules 2, 3 and 4, but never rule 1 or the
 *      "never prune the current worktree" rule).
 *
 * Usage:
 *   node scripts/worktrees-prune.mjs             # dry run (default) — prints what
 *                                                 # would be removed, and why
 *   node scripts/worktrees-prune.mjs --dry-run    # explicit no-op alias
 *   node scripts/worktrees-prune.mjs --yes        # actually remove, rules 1-4 apply
 *   node scripts/worktrees-prune.mjs --force      # remove, overriding rules 2, 3 & 4
 *   node scripts/worktrees-prune.mjs --help       # full usage + safety rules
 *
 * The prune decision lives in a pure, unit-tested module
 * (scripts/lib/worktrees-prune-core.mjs); this file only performs the git/fs I/O.
 */
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";

import {
  AGENT_MEMORY_PATH_PREFIX,
  classifyRefreshOutcome,
  classifyWorktree,
  HELP_TEXT,
  isAgentWorktree,
  parseBranchesWithUpstream,
  parseFlags,
  parseGoneBranches,
  parseUnsavedAgentMemory,
  parseWorktrees,
  resolveBranchGone,
  resolveHasUpstream,
} from "./lib/worktrees-prune-core.mjs";

const FLAGS = parseFlags(process.argv.slice(2));

/**
 * Run a git command and return trimmed stdout, or null on failure.
 *
 * @param {string[]} args
 * @returns {string|null}
 */
function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

/**
 * @param {string} p
 * @returns {string} canonical path, falling back to the input when it cannot be resolved
 */
function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * @param {string} path worktree directory
 * @returns {{ mtimeMs: number|null, statErrorCode: string|null }} the directory's
 *   mtime when the stat succeeded, or the failed stat's `err.code` (e.g.
 *   `"ENOENT"` when the directory is already gone, `"EACCES"` when it is
 *   merely unreadable). The core's `resolveActivity` reads this to fail SAFE:
 *   only `ENOENT` is treated as "nothing to protect"; every other failure is
 *   treated as "unknown, presume active" (Issue #986 follow-up).
 */
export function statInfo(path) {
  try {
    return { mtimeMs: statSync(path).mtimeMs, statErrorCode: null };
  } catch (err) {
    const code = err && typeof err.code === "string" ? err.code : "UNKNOWN";
    return { mtimeMs: null, statErrorCode: code };
  }
}

/**
 * Issue #992 — the worktree's private gitdir metadata directory, e.g.
 * `<repo>/.git/worktrees/<name>/`. Every worktree's registration lives there
 * (see `git worktree add` / `git help gitrepository-layout`); the directory
 * name is the worktree's id, which git derives from the basename of the
 * worktree path (with a numeric suffix on collision — a mismatch here just
 * means the gitdir probes below all miss and the CLI falls back to the root
 * mtime, per {@link resolveActivity}'s fail-safe combination rules).
 *
 * @param {string} commonGitDir absolute path to the shared `.git` dir
 *   (`git rev-parse --git-common-dir`)
 * @param {string} worktreePath absolute worktree path
 * @returns {string} absolute path to that worktree's gitdir metadata directory
 */
export function worktreeGitdir(commonGitDir, worktreePath) {
  return join(commonGitDir, "worktrees", basename(worktreePath));
}

/**
 * Issue #992 — stat the worktree's private gitdir activity files. `index`,
 * `HEAD`, and `logs/HEAD` are touched by essentially any git operation
 * (`add`, `commit`, `checkout`, a HEAD update) performed in that worktree, so
 * together they are a far stronger liveness signal than the worktree root
 * directory's own mtime (which POSIX only bumps when a *direct* child is
 * created/removed — not on edits to files nested deeper). Whichever files
 * exist are stat'd; any that are missing or unreadable are simply omitted —
 * {@link resolveActivity} falls back to the root mtime in that case rather
 * than treating it as an error.
 *
 * Exported (Issue #997) so `.github/hooks/scripts/session-start.mjs` can
 * probe the SAME gitdir-aware activity signal this CLI uses for its own
 * prune-eligibility decision, rather than growing a second, drift-prone copy
 * of this path-construction logic. This module is import-safe: `main()`
 * below only runs when the file is executed directly (see the
 * `process.argv[1]` guard at the bottom), never as a side effect of import.
 *
 * @param {string} commonGitDir absolute path to the shared `.git` dir
 * @param {string} worktreePath absolute worktree path
 * @returns {{mtimeMs: number|null, statErrorCode: string|null}[]}
 */
export function gitdirProbesFor(commonGitDir, worktreePath) {
  if (!commonGitDir) return [];
  const dir = worktreeGitdir(commonGitDir, worktreePath);
  return [join(dir, "index"), join(dir, "HEAD"), join(dir, "logs", "HEAD")].map(statInfo);
}

/**
 * Issue #1147 — the paths in `worktreePath` that hold uncommitted or untracked
 * agent memory. Agent memory (`.claude/agent-memory/`) is tracked in git and is
 * how one agent hands a diagnosis to the next; a file written but never
 * committed exists ONLY inside the throwaway worktree, and pruning it destroys
 * it (that nearly happened — the file had to be rescued by hand into PR #1140).
 *
 * `null` means the probe could not run, which {@link classifyWorktree} treats as
 * "something to lose" — the same fail-safe direction this script already takes
 * for an unreadable mtime.
 *
 * @param {string} worktreePath absolute worktree path
 * @returns {string[]|null} repo-relative agent-memory paths with pending
 *   content, or `null` when `git status` could not be run there
 */
export function unsavedAgentMemoryIn(worktreePath) {
  const out = git([
    "-C",
    worktreePath,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    // Pathspec is relative to -C, i.e. to the worktree's own top level.
    AGENT_MEMORY_PATH_PREFIX,
  ]);
  return out === null ? null : parseUnsavedAgentMemory(out);
}

/**
 * @param {string} head worktree HEAD sha
 * @returns {boolean} true when HEAD is an ancestor of origin/main
 */
function isMergedIntoMain(head) {
  if (!head) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", head, "origin/main"], {
      stdio: "ignore",
    });
    return true; // exit 0 → ancestor
  } catch {
    return false; // exit 1 (not ancestor) or 128 (unknown object)
  }
}

/**
 * Best-effort refresh of remote-tracking refs so `[gone]` detection is accurate.
 *
 * Squash-merges with `--delete-branch` (this repo's default) delete the remote
 * branch, but the local remote-tracking ref lingers until pruned — so a merged
 * branch keeps a live upstream and never shows `[gone]` until we prune. We prefer
 * `git fetch --prune origin` (network + prune); on failure fall back to the
 * offline `git remote prune origin`; if that also fails we warn and continue. A
 * refresh failure must never abort the prune.
 */
function refreshRemoteRefs() {
  const fetchOk = git(["fetch", "--prune", "origin", "--quiet"]) !== null;
  const remotePruneOk = fetchOk ? false : git(["remote", "prune", "origin"]) !== null;
  const outcome = classifyRefreshOutcome({ fetchOk, remotePruneOk });
  if (outcome.message) {
    (outcome.warn ? console.warn : console.log)(outcome.message);
  }
}

/**
 * Local branch names whose upstream is gone (deleted remote — e.g. squash-merged
 * and `--delete-branch`ed). Empty on failure (best-effort).
 *
 * @returns {Set<string>}
 */
function goneBranches() {
  const out = git(["for-each-ref", "--format=%(refname:short) %(upstream:track)", "refs/heads"]);
  return parseGoneBranches(out ?? "");
}

/**
 * Local branch names that have an upstream configured at all (independent of
 * whether it is `[gone]`) — the signal safety rule 2 needs to tell "never had an
 * upstream, by design" apart from "had one, now deleted". Empty on failure.
 *
 * @returns {Set<string>}
 */
function branchesWithUpstream() {
  const out = git(["for-each-ref", "--format=%(refname:short) %(upstream)", "refs/heads"]);
  return parseBranchesWithUpstream(out ?? "");
}

function main() {
  if (FLAGS.help) {
    console.log(HELP_TEXT);
    return;
  }

  // Refresh remote-tracking refs first so merged/gone branches are detected against
  // the latest origin state (fetch --prune → remote prune → warn; never aborts).
  refreshRemoteRefs();
  const gone = goneBranches();
  const withUpstream = branchesWithUpstream();

  const currentTop = git(["rev-parse", "--show-toplevel"]);
  const currentCanonical = currentTop ? canonical(currentTop) : null;

  // Issue #992 — the shared `.git` dir, resolved to an absolute path (`git
  // rev-parse` can print a path relative to the CWD, e.g. plain `.git`).
  // Every worktree's private gitdir metadata lives under
  // `<commonGitDir>/worktrees/<name>/`; see gitdirProbesFor().
  const rawCommonGitDir = git(["rev-parse", "--git-common-dir"]);
  const commonGitDir = rawCommonGitDir
    ? canonical(
        isAbsolute(rawCommonGitDir) ? rawCommonGitDir : join(process.cwd(), rawCommonGitDir),
      )
    : null;

  const porcelain = git(["worktree", "list", "--porcelain"]);
  if (porcelain === null) {
    console.error("worktrees:prune — `git worktree list` failed; is this a git repo?");
    process.exit(1);
  }

  const worktrees = parseWorktrees(porcelain);
  const agentWorktrees = worktrees.filter((wt) => isAgentWorktree(wt.path));

  const nowMs = Date.now();
  const pruned = [];
  const skipped = [];

  for (const wt of agentWorktrees) {
    const isCurrent = currentCanonical !== null && canonical(wt.path) === currentCanonical;
    // A branch is "gone" when the worktree is detached (no branch) or its branch's
    // upstream was deleted (squash-merged + --delete-branch), now visible after the
    // remote-ref refresh above. Both mappings are pure, unit-tested helpers in the
    // core — this file only supplies the raw git state.
    const branchGone = resolveBranchGone({
      detached: wt.detached,
      branch: wt.branch,
      goneBranches: gone,
    });
    const hasUpstream = resolveHasUpstream({
      branch: wt.branch,
      branchesWithUpstream: withUpstream,
    });
    const { mtimeMs, statErrorCode } = statInfo(wt.path);
    const gitdirProbes = gitdirProbesFor(commonGitDir, wt.path);
    // Issue #1147 — probe for unsaved agent memory only when the answer can
    // change the outcome: locked and current worktrees are already never pruned,
    // and an ENOENT directory has nothing left to rescue (probing it would
    // return `null` and pin an already-deleted path as unprunable forever).
    const skipMemoryProbe = wt.locked || isCurrent || statErrorCode === "ENOENT";
    const unsavedAgentMemory = skipMemoryProbe ? [] : unsavedAgentMemoryIn(wt.path);

    const decision = classifyWorktree({
      path: wt.path,
      branch: wt.branch,
      locked: wt.locked,
      isMerged: isMergedIntoMain(wt.head),
      branchGone,
      hasUpstream,
      isCurrent,
      mtimeMs,
      statErrorCode,
      gitdirProbes,
      unsavedAgentMemory,
      nowMs,
      force: FLAGS.force,
    });

    const memoryPaths = unsavedAgentMemory ?? [];

    if (!decision.prune) {
      skipped.push({ path: wt.path, reason: decision.reason, memoryPaths });
      continue;
    }

    // Issue #1147 — reaching here with pending memory means --force overrode the
    // guard. Name the files that are about to be destroyed; a silent delete is
    // what made the original loss invisible.
    if (memoryPaths.length > 0) {
      console.warn(
        `  ! ${wt.path} holds ${memoryPaths.length} uncommitted agent-memory file(s); ` +
          `--force ${FLAGS.apply ? "is removing" : "would remove"} them unrecovered:`,
      );
      for (const p of memoryPaths) console.warn(`      ${p}`);
    }

    if (!FLAGS.apply) {
      pruned.push({ path: wt.path, reason: decision.reason });
      continue;
    }

    const result = git(["worktree", "remove", "--force", wt.path]);
    if (result === null) {
      console.error(`  ! failed to remove ${wt.path} (skipped)`);
      continue;
    }
    pruned.push({ path: wt.path, reason: decision.reason });
  }

  if (FLAGS.apply && pruned.length > 0) {
    git(["worktree", "prune"]);
  }

  const verb = FLAGS.apply ? "pruned" : "would prune";
  console.log(
    `worktrees:prune — inspected ${agentWorktrees.length} agent worktree(s), ` +
      `${verb} ${pruned.length}, skipped ${skipped.length}.`,
  );
  for (const p of pruned) {
    console.log(`  ${FLAGS.apply ? "removed" : "would remove"}: ${p.path} (${p.reason})`);
  }
  for (const s of skipped) {
    console.log(`  skipped: ${s.path} (${s.reason})`);
    if (s.reason === "unsaved-agent-memory") {
      // Issue #1147 — print the files so the operator can commit them (that is
      // the fix; `--force` only discards them).
      for (const p of s.memoryPaths) console.log(`      pending: ${p}`);
      console.log("      → commit these, then re-run; or --force to discard them");
    }
  }
  if (!FLAGS.apply) {
    console.log(
      "(dry run — nothing was removed; re-run with --yes to apply, or --help for details)",
    );
  }
}

// Issue #997 — this module is now also imported (for `gitdirProbesFor` /
// `statInfo`) by `.github/hooks/scripts/session-start.mjs`. Only run the CLI
// when this file is executed directly, never as a side effect of import.
if (process.argv[1]?.endsWith("worktrees-prune.mjs")) {
  main();
}
