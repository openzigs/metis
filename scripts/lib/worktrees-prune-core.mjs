/**
 * Pure decision logic for `pnpm worktrees:prune` (Issue #916).
 *
 * ## Why this exists
 *
 * Long-running multi-agent work leaves dozens of throwaway git worktrees under
 * `.claude/worktrees/agent-*`. Most sit on branches that have already merged into
 * `origin/main` or have been detached/deleted. They clutter `git worktree list`,
 * consume disk, and make the live worktrees hard to spot. The CLI in
 * `scripts/worktrees-prune.mjs` gathers git state (side effects) and delegates the
 * "should this one be removed?" call to the pure functions here so the decision is
 * unit-testable without touching a real repository.
 */

/**
 * Path fragment that identifies an agent-created worktree. Only worktrees whose
 * path contains this marker are ever eligible for pruning — human worktrees and
 * the primary checkout are always left alone.
 */
export const AGENT_WORKTREE_MARKER = ".claude/worktrees/agent-";

/**
 * Branch-name prefix used for the auto-generated, local-only branches that back
 * agent isolation worktrees (see `scripts/lib/worktree-isolation.mjs` et al.).
 * These branches never have an upstream by design — a lesson learned the hard
 * way in Issue #986, where that absence was previously indistinguishable from a
 * genuinely abandoned/merged branch and caused active worktrees to be deleted.
 */
export const AGENT_BRANCH_PREFIX = "worktree-agent-";

/**
 * Idle window (ms). A worktree whose directory was modified more recently than
 * this is presumed to have in-flight work and is never pruned, regardless of its
 * branch state. Two hours comfortably covers a single agent turn plus review.
 */
export const RECENT_ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Repo-relative path prefix of the durable agent memory store (Issue #1147).
 *
 * `.claude/agent-memory/` is tracked in git and is the mechanism by which one
 * agent hands a hard-won diagnosis to the next — #1110's agent recorded that
 * adding a named export to `server/src/lib/analysis/synthesis.ts` breaks ~48
 * tests across 7 files, and #1111/#1116/#1136 were each handed that warning and
 * none of them hit it. Because an isolation worktree gets its own copy of the
 * tree, an agent that writes a memory file and does not commit it leaves the
 * only copy inside a throwaway directory: on one occasion this prune script
 * would have deleted it, and it had to be rescued by hand into PR #1140. Safety
 * rule 4 below exists so that never becomes a silent loss.
 */
export const AGENT_MEMORY_PATH_PREFIX = ".claude/agent-memory/";

/**
 * @param {string} path absolute worktree path
 * @returns {boolean} true when the path belongs to an agent worktree
 */
export function isAgentWorktree(path) {
  return typeof path === "string" && path.includes(AGENT_WORKTREE_MARKER);
}

/**
 * @typedef {object} WorktreeRecord
 * @property {string} path       absolute worktree path
 * @property {string|null} head  HEAD sha, or null when unknown
 * @property {string|null} branch branch name, or null when detached
 * @property {boolean} detached  true when not on a branch
 * @property {boolean} locked    true when the worktree is locked
 * @property {boolean} bare      true for a bare repository
 */

/**
 * Parse the output of `git worktree list --porcelain` into structured records.
 *
 * The porcelain format emits one attribute per line, records separated by a blank
 * line:
 *
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>   (omitted when detached)
 *   detached                   (present when not on a branch)
 *   locked [<reason>]          (present when locked)
 *   bare                       (present for a bare repo)
 *
 * @param {string} porcelain raw stdout of `git worktree list --porcelain`
 * @returns {WorktreeRecord[]}
 */
export function parseWorktrees(porcelain) {
  /** @type {WorktreeRecord[]} */
  const records = [];
  if (typeof porcelain !== "string" || porcelain.trim() === "") return records;

  /** @type {WorktreeRecord|null} */
  let current = null;
  const push = () => {
    if (current && current.path) records.push(current);
    current = null;
  };

  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") {
      push();
      continue;
    }
    if (line.startsWith("worktree ")) {
      push();
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        detached: false,
        locked: false,
        bare: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      // Strip the refs/heads/ prefix to expose the plain branch name.
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "bare") {
      current.bare = true;
    }
  }
  push();
  return records;
}

/**
 * @typedef {object} PruneDecision
 * @property {boolean} prune  true when the worktree should be removed
 * @property {string} reason  machine-readable reason for the decision (used for
 *   both prune and skip cases so the CLI can print an accurate audit trail)
 */

/**
 * @typedef {"fresh"|"stale"|"unknown"} ActivityState
 */

/**
 * @typedef {object} StatProbe
 * @property {number|null} mtimeMs mtime in epoch ms, present only when the
 *   stat succeeded
 * @property {string|null} statErrorCode the failed stat's `err.code`, or
 *   `null`/`undefined` when the stat succeeded
 */

/**
 * Resolve a worktree's activity state for safety rule 4 from mtime probes.
 * Pure so the CLI's `fs.statSync` error handling is unit-testable without
 * spawning `fs`.
 *
 * Issue #986 follow-up: a prior version only ever consulted the worktree
 * root directory's `mtimeMs`, so a failed `statSync` (which the CLI turned
 * into `mtimeMs: null`) silently fell through the `typeof mtimeMs ===
 * "number"` guard and the worktree became prune-eligible — an I/O error
 * degraded a safety rule toward *delete*.
 *
 * Issue #992 follow-up: root directory mtime alone is a weak liveness proxy
 * — on POSIX, editing a file *nested* inside a worktree does not bump the
 * root directory's own mtime, so an agent working for hours on existing
 * files (no new/removed top-level entries) can look idle. Every worktree
 * also has a private per-worktree gitdir under `<repo>/.git/worktrees/<name>/`
 * whose `index` / `HEAD` / `logs/HEAD` files are touched by essentially any
 * git operation (`add`, `commit`, `checkout`, a HEAD update) performed in
 * that worktree. The activity signal is therefore `max(root mtime, gitdir
 * file mtimes)` over whichever of those files can be read — the CLI supplies
 * the root probe via `mtimeMs`/`statErrorCode` (unchanged shape, so this
 * stays back-compatible with #986's call sites) plus zero or more
 * `gitdirProbes`.
 *
 * Combination rules, in order:
 *
 *   1. `statErrorCode === "ENOENT"` on the ROOT probe — the worktree
 *      directory genuinely no longer exists. There is nothing left to
 *      protect, so this resolves to `"stale"` unconditionally, regardless of
 *      any gitdir signal.
 *   2. Otherwise, gather every mtime that could actually be read: the root
 *      mtime (when its stat succeeded) plus each `gitdirProbes` entry whose
 *      stat succeeded. A gitdir probe that failed (missing file, unreadable,
 *      the gitdir itself gone) is simply excluded from that set — it never
 *      turns an otherwise-successful root read into `"unknown"` (a missing
 *      gitdir falls back to the root mtime, still fail-safe).
 *   3. If NO mtime could be read at all (root failed non-ENOENT and every
 *      gitdir probe also failed/was absent), the result is `"unknown"` — the
 *      caller must treat this the same as `"fresh"` (keep); an I/O error
 *      must fail SAFE, never toward delete.
 *   4. Otherwise, `"fresh"` when the NEWEST readable mtime is within
 *      `windowMs` of `nowMs`, else `"stale"`.
 *
 * @param {object} args
 * @param {number|null} [args.mtimeMs] worktree ROOT directory mtime in epoch
 *   ms, present only when that stat succeeded
 * @param {string|null} [args.statErrorCode] the ROOT stat's failed
 *   `err.code`, or `null`/`undefined` when it succeeded
 * @param {StatProbe[]} [args.gitdirProbes] stat results for the worktree's
 *   private gitdir files (`index`, `HEAD`, `logs/HEAD`); defaults to `[]` so
 *   existing #986 call sites that only ever knew about the root probe are
 *   unaffected
 * @param {number} args.nowMs current time in epoch ms
 * @param {number} args.windowMs the recent-activity window in ms
 * @returns {ActivityState}
 */
export function resolveActivity({
  mtimeMs = null,
  statErrorCode = null,
  gitdirProbes = [],
  nowMs,
  windowMs,
}) {
  if (statErrorCode === "ENOENT") {
    return "stale";
  }

  const readableMtimes = [];
  if (typeof mtimeMs === "number" && !statErrorCode) {
    readableMtimes.push(mtimeMs);
  }
  for (const probe of Array.isArray(gitdirProbes) ? gitdirProbes : []) {
    if (probe && typeof probe.mtimeMs === "number" && !probe.statErrorCode) {
      readableMtimes.push(probe.mtimeMs);
    }
  }

  if (readableMtimes.length === 0) {
    return "unknown";
  }

  const newestMs = Math.max(...readableMtimes);
  return nowMs - newestMs < windowMs ? "fresh" : "stale";
}

/**
 * Extract the repo-relative paths of uncommitted (modified, staged, deleted,
 * renamed) or untracked files under {@link AGENT_MEMORY_PATH_PREFIX} from
 * `git status --porcelain --untracked-files=all` output (Issue #1147).
 *
 * Pure so the guard's parsing is unit-testable without a real worktree. The CLI
 * runs the status command with a `-- .claude/agent-memory` pathspec, but this
 * function filters on the prefix independently so it is also correct against a
 * whole-repo status.
 *
 * Porcelain v1 emits `XY <path>` per entry, where `XY` is the two-character
 * status code (`?? ` untracked, ` M ` unstaged modification, `A  ` added, `R  `
 * rename, …). A rename/copy entry renders its path field as `<orig> -> <dest>`;
 * the destination is what would be lost, so that is what is reported. Paths
 * containing unusual characters are emitted double-quoted, and the quotes are
 * stripped for display.
 *
 * @param {string} porcelain raw stdout of `git status --porcelain`
 * @returns {string[]} repo-relative agent-memory paths with uncommitted content
 */
export function parseUnsavedAgentMemory(porcelain) {
  /** @type {string[]} */
  const paths = [];
  if (typeof porcelain !== "string" || porcelain.trim() === "") return paths;

  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    // `XY ` — two status chars plus a separating space; anything shorter is not
    // a status entry (e.g. a trailing blank line).
    if (line.length <= 3) continue;
    // `!!` entries only appear with --ignored and are not pending work.
    if (line.startsWith("!!")) continue;
    let candidate = line.slice(3);
    const arrow = candidate.indexOf(" -> ");
    if (arrow !== -1) candidate = candidate.slice(arrow + " -> ".length);
    const cleaned = candidate.replace(/^"|"$/g, "").trim();
    if (cleaned.startsWith(AGENT_MEMORY_PATH_PREFIX) && !paths.includes(cleaned)) {
      paths.push(cleaned);
    }
  }
  return paths;
}

/**
 * Decide whether a single worktree should be pruned, and why.
 *
 * Evaluated in this precedence order (Issue #986 — a prior version of this
 * function deleted *active* agent worktrees because it never consulted `locked`
 * and could not tell "no upstream by design" apart from "abandoned"):
 *
 *   1. `not-an-agent-worktree` — only agent worktrees are ever eligible.
 *   2. `locked`                — a `git worktree lock`ed worktree is NEVER
 *                                 pruned. No flag (not even `--force`) overrides
 *                                 this; it is the hard safety backstop.
 *   3. `current-worktree`      — the worktree the command itself runs in is
 *                                 never removed, forced or not.
 *   3.5 `unsaved-agent-memory` / `agent-memory-status-unknown` — the worktree
 *                                 holds uncommitted or untracked files under
 *                                 `.claude/agent-memory/`, or that could not be
 *                                 determined at all. Removing it would destroy
 *                                 the only copy of a durable cross-agent
 *                                 diagnosis (Issue #1147 — it nearly did once;
 *                                 the file had to be rescued by hand into PR
 *                                 #1140). Skipped unless `force` is set, which
 *                                 the CLI reports as a destructive override
 *                                 rather than performing it silently (`--help`
 *                                 numbers this safety rule 4). Ranked
 *                                 above the activity window deliberately: both
 *                                 outcomes are "keep", but this reason names an
 *                                 action the operator must take (commit the
 *                                 memory) rather than one they can wait out.
 *   4. `recently-active` / `mtime-unknown` — the worktree directory was
 *                                 modified within the last
 *                                 `RECENT_ACTIVITY_WINDOW_MS` (`recently-active`,
 *                                 via {@link resolveActivity}), OR its mtime
 *                                 could not be determined at all — e.g. a
 *                                 `statSync` failure other than `ENOENT`
 *                                 (`mtime-unknown`; Issue #986 follow-up — an
 *                                 unreadable mtime must fail SAFE toward "keep",
 *                                 not toward "prune"). `ENOENT` (the directory
 *                                 genuinely no longer exists) is the one
 *                                 legitimate exception and does not block.
 *                                 Presumed to have in-flight work either way.
 *                                 Skipped when `force` is set.
 *   5. `agent-branch-no-upstream` / `forced-agent-branch-no-upstream` — a branch
 *                                 named `${AGENT_BRANCH_PREFIX}*` with no
 *                                 upstream is ephemeral-by-design, not
 *                                 "merged and stale". Protected unless `force`.
 *   6. `merged-into-main` / `branch-gone` — the genuinely useful #916 behavior:
 *                                 prune when the branch tip is an ancestor of
 *                                 `origin/main`, or its upstream is `[gone]`
 *                                 (squash-merge + `--delete-branch`), or the
 *                                 worktree is detached.
 *   7. `active`                — none of the above; keep it.
 *
 * @param {object} args
 * @param {string} args.path       worktree path
 * @param {string|null} [args.branch] branch name, or null when detached
 * @param {boolean} [args.locked]  true when `git worktree list --porcelain`
 *   reports this worktree as locked
 * @param {boolean} [args.isMerged] branch tip is an ancestor of origin/main
 * @param {boolean} [args.branchGone] branch's upstream no longer exists
 *   (detached counts as gone too); inferred from `branch === null` when omitted
 * @param {boolean} [args.hasUpstream] the branch has an upstream configured at
 *   all (independent of whether that upstream is `[gone]`); defaults to
 *   `false` — the fail-safe direction for a safety classifier — so a caller
 *   that omits this field protects the branch (rule 5) rather than silently
 *   re-arming the #986 bug. Callers must explicitly pass `true` to lift the
 *   protection.
 * @param {boolean} [args.isCurrent] this is the worktree the command runs in
 * @param {number|null} [args.mtimeMs] worktree ROOT directory mtime in epoch
 *   ms, present only when the stat succeeded
 * @param {string|null} [args.statErrorCode] the ROOT `statSync`'s failed
 *   `err.code` (e.g. `"ENOENT"`, `"EACCES"`), or `null`/`undefined` when the
 *   stat succeeded. See {@link resolveActivity}.
 * @param {StatProbe[]} [args.gitdirProbes] stat results for the worktree's
 *   private gitdir files (`index`, `HEAD`, `logs/HEAD`) — Issue #992's
 *   `max(root mtime, gitdir mtimes)` activity signal. See
 *   {@link resolveActivity}.
 * @param {string[]|null} [args.unsavedAgentMemory] repo-relative
 *   `.claude/agent-memory/` paths in this worktree with uncommitted or
 *   untracked content (see {@link parseUnsavedAgentMemory}), or `null` when the
 *   probe could not run — which is treated the same as "there is something to
 *   lose", matching this module's fail-safe posture for an unreadable mtime.
 *   Defaults to `[]` (nothing unsaved) so every pre-#1147 call site keeps its
 *   exact behaviour; the CLI always supplies it.
 * @param {number} [args.nowMs] current time in epoch ms (defaults to `Date.now()`)
 * @param {boolean} [args.force] `--force`: overrides the unsaved-agent-memory
 *   guard, the recently-active/mtime-unknown window and the
 *   agent-branch-without-upstream protection. Never overrides `locked` or
 *   `isCurrent`.
 * @returns {PruneDecision}
 */
export function classifyWorktree({
  path,
  branch = null,
  locked = false,
  isMerged = false,
  branchGone,
  hasUpstream = false,
  isCurrent = false,
  mtimeMs = null,
  statErrorCode = null,
  gitdirProbes = [],
  unsavedAgentMemory = [],
  nowMs = Date.now(),
  force = false,
}) {
  if (!isAgentWorktree(path)) {
    return { prune: false, reason: "not-an-agent-worktree" };
  }
  if (locked) {
    return { prune: false, reason: "locked" };
  }
  if (isCurrent) {
    return { prune: false, reason: "current-worktree" };
  }
  if (!force) {
    if (unsavedAgentMemory === null) {
      return { prune: false, reason: "agent-memory-status-unknown" };
    }
    if (unsavedAgentMemory.length > 0) {
      return { prune: false, reason: "unsaved-agent-memory" };
    }

    const activity = resolveActivity({
      mtimeMs,
      statErrorCode,
      gitdirProbes,
      nowMs,
      windowMs: RECENT_ACTIVITY_WINDOW_MS,
    });
    if (activity === "fresh") {
      return { prune: false, reason: "recently-active" };
    }
    if (activity === "unknown") {
      return { prune: false, reason: "mtime-unknown" };
    }
  }

  const isAgentBranch = typeof branch === "string" && branch.startsWith(AGENT_BRANCH_PREFIX);
  if (isAgentBranch && !hasUpstream) {
    if (!force) return { prune: false, reason: "agent-branch-no-upstream" };
    return { prune: true, reason: "forced-agent-branch-no-upstream" };
  }

  const gone = branchGone === undefined ? branch === null : Boolean(branchGone);
  if (isMerged) {
    return { prune: true, reason: "merged-into-main" };
  }
  if (gone) {
    return { prune: true, reason: "branch-gone" };
  }

  return { prune: false, reason: "active" };
}

/**
 * Thin boolean wrapper over {@link classifyWorktree} kept for callers (and
 * existing test coverage) that only need the yes/no decision, not the reason.
 *
 * @param {Parameters<typeof classifyWorktree>[0]} args
 * @returns {boolean}
 */
export function shouldPrune(args) {
  return classifyWorktree(args).prune;
}

/**
 * Parse `git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads`
 * into the set of local branch names whose upstream is gone (i.e. the remote branch
 * was deleted — as happens after a squash-merge with `--delete-branch`).
 *
 * The track field is one of: empty, `[gone]`, `[ahead N]`, `[behind N]`,
 * `[ahead N, behind M]`. Only `[gone]` marks a deleted upstream. Branch names never
 * contain spaces, so a line is "gone" exactly when it ends with the `[gone]` token.
 *
 * @param {string} output raw stdout of the for-each-ref command
 * @returns {Set<string>} branch names whose upstream is gone
 */
export function parseGoneBranches(output) {
  /** @type {Set<string>} */
  const gone = new Set();
  if (typeof output !== "string" || output.trim() === "") return gone;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (line === "" || !line.endsWith("[gone]")) continue;
    const name = line.slice(0, -"[gone]".length).trim();
    if (name !== "") gone.add(name);
  }
  return gone;
}

/**
 * Parse `git for-each-ref --format='%(refname:short) %(upstream)' refs/heads`
 * into the set of local branch names that have an upstream configured **at all**
 * — independent of whether that upstream is currently `[gone]` (see
 * {@link parseGoneBranches}). This is the signal Issue #986's safety rule 2
 * needs: a `worktree-agent-*` branch that never had an upstream (by design) must
 * not be conflated with a real branch whose upstream was deleted after a merge.
 *
 * The `%(upstream)` field is empty when no upstream is configured, or a full ref
 * (e.g. `refs/remotes/origin/feature/x`) when one is. Branch names never contain
 * spaces, so the first space always separates the branch name from the upstream
 * field.
 *
 * @param {string} output raw stdout of the for-each-ref command
 * @returns {Set<string>} branch names that have a configured upstream
 */
export function parseBranchesWithUpstream(output) {
  /** @type {Set<string>} */
  const withUpstream = new Set();
  if (typeof output !== "string" || output.trim() === "") return withUpstream;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;
    const name = line.slice(0, spaceIdx);
    const upstream = line.slice(spaceIdx + 1).trim();
    if (name !== "" && upstream !== "") withUpstream.add(name);
  }
  return withUpstream;
}

/**
 * Map a parsed worktree record onto {@link classifyWorktree}'s `branchGone`
 * input. Pure so this fail-safe inversion — a worktree is "gone" only when we
 * have positive evidence (detached, or the branch's upstream was observed as
 * `[gone]`) — gets the same unit-test treatment as the classifier itself,
 * rather than living as an inline expression in the CLI.
 *
 * @param {object} args
 * @param {boolean} args.detached true when the worktree has no branch
 * @param {string|null} args.branch branch name, or null when detached
 * @param {Set<string>} args.goneBranches branch names whose upstream is
 *   `[gone]` (see {@link parseGoneBranches})
 * @returns {boolean}
 */
export function resolveBranchGone({ detached, branch, goneBranches }) {
  return Boolean(detached) || (branch !== null && goneBranches.has(branch));
}

/**
 * Map a parsed worktree record onto {@link classifyWorktree}'s `hasUpstream`
 * input. Pure for the same reason as {@link resolveBranchGone} — this is the
 * computation that feeds safety rule 5, and a branch absent from
 * `branchesWithUpstream` (never observed, or a failed `git for-each-ref`
 * yielding an empty set) correctly resolves to `false` (protected), matching
 * {@link classifyWorktree}'s fail-safe `hasUpstream` default.
 *
 * @param {object} args
 * @param {string|null} args.branch branch name, or null when detached
 * @param {Set<string>} args.branchesWithUpstream branch names that have a
 *   configured upstream at all (see {@link parseBranchesWithUpstream})
 * @returns {boolean}
 */
export function resolveHasUpstream({ branch, branchesWithUpstream }) {
  return branch !== null && branchesWithUpstream.has(branch);
}

/**
 * Decide how the remote-tracking refresh went, given the outcome of the two
 * best-effort git attempts. Pure so the fetch → remote-prune → warn fallback ladder
 * is unit-testable without spawning git.
 *
 * `git fetch --prune origin` is preferred (updates origin/main AND prunes deleted
 * remote branches). If it fails (offline / sandbox / no network) we fall back to
 * `git remote prune origin`, which prunes stale remote-tracking refs from local
 * state without any network. If that also fails we warn and continue — the prune is
 * best-effort and must never abort on a refresh failure.
 *
 * @param {object} args
 * @param {boolean} args.fetchOk `git fetch --prune origin` succeeded
 * @param {boolean} [args.remotePruneOk] `git remote prune origin` succeeded
 *   (only attempted when the fetch failed)
 * @returns {{ status: "fetched"|"pruned"|"warn", warn: boolean, message: string|null }}
 */
export function classifyRefreshOutcome({ fetchOk, remotePruneOk = false }) {
  if (fetchOk) {
    return { status: "fetched", warn: false, message: null };
  }
  if (remotePruneOk) {
    return {
      status: "pruned",
      warn: false,
      message:
        "worktrees:prune — `git fetch --prune` failed; pruned stale remote refs offline instead.",
    };
  }
  return {
    status: "warn",
    warn: true,
    message:
      "worktrees:prune — could not refresh remote-tracking refs (offline?); " +
      "[gone] detection may be stale, continuing best-effort.",
  };
}

/**
 * @typedef {object} PruneFlags
 * @property {boolean} apply  actually remove worktrees (vs. print-only)
 * @property {boolean} yes    `--yes` was passed
 * @property {boolean} force  `--force` was passed
 * @property {boolean} dryRun true when nothing will be removed (the inverse of `apply`)
 * @property {boolean} help   `--help`/`-h` was passed
 */

/**
 * Parse the prune CLI's flags. Pure so the default-dry-run / `--yes` / `--force`
 * semantics (Issue #986 safety rule 4) are unit-testable without spawning the
 * script.
 *
 * Semantics:
 *   - No flags            → dry run, nothing deleted (the new default).
 *   - `--yes`              → apply (delete), subject to all other safety rules.
 *   - `--force`             → apply, AND overrides the agent-branch-without-
 *     upstream and recently-active rules. Never overrides `locked` or the
 *     current-worktree check (those live in {@link classifyWorktree} and take
 *     no flag input at all).
 *   - `--dry-run`           → explicit no-op alias, kept for back-compat with
 *     #916. Wins over `--yes`/`--force` when combined, so an operator can never
 *     accidentally apply by pasting a stale command with both flags.
 *   - `--help` / `-h`       → print usage and exit without evaluating anything.
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {PruneFlags}
 */
export function parseFlags(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const dryRunFlag = args.includes("--dry-run");
  const yesFlag = args.includes("--yes");
  const forceFlag = args.includes("--force");
  const help = args.includes("--help") || args.includes("-h");
  const apply = (yesFlag || forceFlag) && !dryRunFlag;
  return { apply, yes: yesFlag, force: forceFlag, dryRun: !apply, help };
}

/**
 * `--help` output. Kept here (rather than inline in the CLI) so its content —
 * every flag, all four Issue #986 safety rules, and Issue #1147's agent-memory
 * rule — is asserted by unit tests.
 */
export const HELP_TEXT = `Usage: node scripts/worktrees-prune.mjs [--yes|--force] [--dry-run] [--help]

Prune stale agent git worktrees under .claude/worktrees/agent-* (Issue #916,
hardened by Issue #986 after it twice deleted worktrees still in active use).

Flags:
  (none)       Dry run (the default). Prints what WOULD be removed and why, and
               a summary of what was skipped and why. Deletes nothing.
  --dry-run    Explicit no-op alias for the default, kept for back-compat. Wins
               over --yes/--force when combined with either.
  --yes        Actually remove the worktrees classified as prunable. All safety
               rules below still apply.
  --force      Implies --yes, AND additionally overrides safety rules 2, 3 and 4
               below (agent-branch-without-upstream, recently-active, unsaved
               agent memory). Does NOT override rule 1 (locked) or the "never
               prune the current worktree" rule — nothing overrides those.
  --help, -h   Print this message and exit.

Safety rules:
  1. Locked worktrees (\`git worktree lock\`) are NEVER pruned, no matter what
     flags are passed.
  2. Worktrees on a "${AGENT_BRANCH_PREFIX}*" branch with no upstream are
     ephemeral-by-design — not "merged and stale" — and are skipped unless
     --force is passed.
  3. Worktrees whose activity signal is within the last
     ${RECENT_ACTIVITY_WINDOW_MS / (60 * 60 * 1000)} hours (recently active) are skipped unless --force is passed. The
     signal is max(root directory mtime, private gitdir file mtimes) — the
     gitdir's index/HEAD/logs/HEAD files are touched by any git operation, so
     editing files nested inside the worktree still counts as activity even
     when the root directory's own mtime is untouched (Issue #992). An
     unreadable mtime (every probe fails, and the root failure is not the
     directory no longer existing) is treated the same way — as active, and
     kept — unless --force is passed.
  4. Worktrees holding uncommitted or untracked files under
     "${AGENT_MEMORY_PATH_PREFIX}" are skipped unless --force is passed, and
     --force names the files it is about to destroy rather than deleting them
     silently. Agent memory is the cross-session diagnosis channel and is meant
     to be COMMITTED, not left in a throwaway worktree: one such file was nearly
     lost this way and had to be rescued by hand into PR #1140 (Issue #1147). A
     probe that cannot run at all counts as "something to lose" and also skips.
  5. Deleting requires an explicit --yes (or --force); dry run is the default.

The genuinely useful #916 behavior is preserved: agent worktrees on real
branches that are merged into origin/main, or whose upstream is [gone] (the
squash-merge + --delete-branch case), are still pruned once you opt in with
--yes.

The current worktree and the primary checkout are never touched.`;
