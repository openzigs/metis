/**
 * Pure decision logic for locking agent isolation worktrees for their whole
 * lifetime (Issue #992, follow-up to #986 / #916).
 *
 * ## Why this exists
 *
 * `pnpm worktrees:prune` (see `scripts/lib/worktrees-prune-core.mjs`) already
 * refuses to delete a `locked` worktree unconditionally. That guard is only as
 * good as the harness actually locking every isolation worktree for its whole
 * life: previously nothing locked a worktree once an agent had checked out a
 * *real* feature branch (the `worktree-agent-*` branch-name heuristic no
 * longer matched), leaving only a weak 2h mtime window standing between an
 * active agent and deletion.
 *
 * The Claude Code harness fires `SubagentStart` / `SubagentStop` hooks with a
 * reliable `cwd` (the agent's isolation worktree) and `agent_id`. This module
 * holds the pure "should we act, and on what path" logic so the thin hook
 * glue (`.github/hooks/scripts/subagent-log.mjs`, `session-start.mjs`) can
 * stay a few lines of `execFileSync` plumbing, unit-tested without spawning a
 * real git process.
 *
 * A second, related bug lives here too: the pre-#992 log-destination logic
 * resolved the "repo root" via `git rev-parse --show-toplevel`, which -
 * -when invoked from *inside* a worktree- returns the WORKTREE root, not the
 * main repo. Lifecycle logs then landed in `<worktree>/.github/hooks/logs/`
 * and were destroyed the moment the worktree was removed, producing the
 * unbalanced Start/Stop counts seen in the main log. `resolveMainRoot` fixes
 * this by preferring `git rev-parse --path-format=absolute --git-common-dir`
 * (which always points at the MAIN repo's `.git`, even from a worktree),
 * falling back to `--show-toplevel` only when that call fails.
 */

/** Directory name prefix identifying an agent isolation worktree. */
export const AGENT_DIR_PREFIX = "agent-";

/**
 * Normalize a filesystem path into a list of non-empty segments, resolving
 * `.`/`..` lexically and treating `\` and `/` as equivalent separators so the
 * same logic works for POSIX and Windows-style hook payloads.
 *
 * @param {unknown} rawPath
 * @returns {string[]}
 */
function toSegments(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0) return [];
  const unified = rawPath.replace(/\\/g, "/");
  const parts = unified.split("/").filter((part) => part.length > 0);
  const out = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

/**
 * @param {unknown} rawPath
 * @returns {boolean} true when the path is absolute on POSIX (`/foo`) or
 *   Windows (`C:\foo`, `C:/foo`, `\\server\share`).
 */
function isAbsolutePath(rawPath) {
  return typeof rawPath === "string" && /^([a-zA-Z]:)?[\\/]/.test(rawPath);
}

/**
 * True when `cwd` names a path inside `<mainRoot>/.claude/worktrees/agent-*`.
 *
 * Uses a real path-segment boundary check (not `String.includes`) so a
 * sibling directory that merely *starts with* the same characters — e.g.
 * `.claude/worktrees-backup/agent-x` or `.claude/worktrees2/agent-x` — never
 * false-positives. `cwd` may be relative (resolved against `mainRoot`) or
 * absolute; trailing slashes and `..` segments are normalized away.
 *
 * @param {unknown} cwd
 * @param {unknown} mainRoot
 * @returns {boolean}
 */
export function isAgentWorktreePath(cwd, mainRoot) {
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  if (typeof mainRoot !== "string" || mainRoot.length === 0) return false;

  const rootSegs = toSegments(mainRoot);
  if (rootSegs.length === 0) return false;

  const cwdSegs = isAbsolutePath(cwd) ? toSegments(cwd) : toSegments(`${mainRoot}/${cwd}`);

  if (cwdSegs.length < rootSegs.length + 3) return false;
  for (let i = 0; i < rootSegs.length; i++) {
    if (cwdSegs[i] !== rootSegs[i]) return false;
  }

  return (
    cwdSegs[rootSegs.length] === ".claude" &&
    cwdSegs[rootSegs.length + 1] === "worktrees" &&
    cwdSegs[rootSegs.length + 2].startsWith(AGENT_DIR_PREFIX)
  );
}

/**
 * Strip a trailing `/.git` (or `\.git`) segment from
 * `git rev-parse --path-format=absolute --git-common-dir` output to recover
 * the MAIN repository root. Returns `null` when the input doesn't look like
 * a recognizable `--git-common-dir` path (empty, whitespace-only, or missing
 * the `.git` suffix entirely — e.g. a bare repo, which this repo never is).
 *
 * @param {unknown} rawGitCommonDir
 * @returns {string|null}
 */
export function resolveMainRootFromGitCommonDir(rawGitCommonDir) {
  if (typeof rawGitCommonDir !== "string") return null;
  const trimmed = rawGitCommonDir.trim();
  if (trimmed.length === 0) return null;
  const unified = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const match = unified.match(/^(.*)\/\.git$/);
  return match ? match[1] : null;
}

/**
 * Resolve the MAIN repo root, preferring `--git-common-dir` (correct from
 * inside a worktree) and falling back to `--show-toplevel` output (correct
 * only when NOT inside a worktree — kept as a fallback for when the common-dir
 * invocation itself fails, e.g. not a git repo at all).
 *
 * @param {object} args
 * @param {unknown} [args.gitCommonDirOutput] raw stdout of
 *   `git rev-parse --path-format=absolute --git-common-dir`, or
 *   `null`/`undefined` when that invocation failed
 * @param {unknown} [args.showToplevelOutput] raw stdout of
 *   `git rev-parse --show-toplevel`, or `null`/`undefined` when that
 *   invocation failed
 * @returns {string|null}
 */
export function resolveMainRoot({ gitCommonDirOutput, showToplevelOutput } = {}) {
  const fromCommonDir = resolveMainRootFromGitCommonDir(gitCommonDirOutput);
  if (fromCommonDir) return fromCommonDir;

  if (typeof showToplevelOutput === "string") {
    const trimmed = showToplevelOutput.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (trimmed.length > 0) return trimmed;
  }

  return null;
}

/**
 * Build the `--reason` string passed to `git worktree lock`.
 *
 * @param {unknown} agentId
 * @returns {string}
 */
export function buildLockReason(agentId) {
  const id = typeof agentId === "string" && agentId.length > 0 ? agentId : "unknown";
  return `agent ${id} active`;
}

/**
 * True when a `git worktree lock` failure is an already-locked race — i.e. a
 * previous SubagentStart already locked this worktree (or the SessionStart
 * reaper unlocked-then-relocked concurrently) — and should be swallowed
 * rather than surfaced.
 *
 * @param {unknown} stderrText
 * @returns {boolean}
 */
export function isTolerableLockError(stderrText) {
  if (typeof stderrText !== "string") return false;
  return stderrText.toLowerCase().includes("already locked");
}

/**
 * True when a `git worktree unlock` failure means there was nothing to do —
 * not locked, or the worktree directory/administrative files are already
 * gone (removed by a normal PR-merge cleanup before SubagentStop fired) —
 * and should be swallowed rather than surfaced.
 *
 * @param {unknown} stderrText
 * @returns {boolean}
 */
export function isTolerableUnlockError(stderrText) {
  if (typeof stderrText !== "string") return false;
  const lower = stderrText.toLowerCase();
  return (
    lower.includes("not locked") ||
    lower.includes("no such file or directory") ||
    lower.includes("is not a working tree") ||
    lower.includes("is not a working directory")
  );
}

/**
 * Build the diagnostic log line for a NON-tolerable `git worktree
 * lock`/`unlock` failure, or `null` when the failure is tolerable (an
 * expected already-locked / not-locked / worktree-gone race) and must stay
 * silent exactly as before.
 *
 * Before this function existed, the hook glue
 * (`.github/hooks/scripts/subagent-log.mjs`) computed `isTolerableLockError`
 * / `isTolerableUnlockError` and then discarded the result (`void
 * tolerable;`) — both branches behaved identically, so a genuinely
 * unexpected lock/unlock failure was indistinguishable from a benign race in
 * what is meant to be a safety-critical defensive path. This function is the
 * single place that both DECIDES (via the existing predicates) and FORMATS,
 * so the hook has one call that actually gates behavior instead of a
 * predicate it never consults.
 *
 * @param {object} args
 * @param {unknown} args.event the raw hook event name (`"SubagentStart"` for
 *   a lock attempt, anything else — in practice `"SubagentStop"` — for an
 *   unlock attempt)
 * @param {unknown} args.cwd the worktree path the lock/unlock targeted
 * @param {unknown} args.stderrText raw stderr text of the failed git command
 * @returns {string|null} a single line (no trailing newline) to append to
 *   the lifecycle log, or `null` when the failure is tolerable and nothing
 *   should be logged
 */
export function buildLockFailureLogLine({ event, cwd, stderrText }) {
  const action = event === "SubagentStart" ? "lock" : "unlock";
  const tolerable =
    action === "lock" ? isTolerableLockError(stderrText) : isTolerableUnlockError(stderrText);
  if (tolerable) return null;

  const worktreePath = typeof cwd === "string" && cwd.length > 0 ? cwd : "unknown";
  const stderr = typeof stderrText === "string" ? stderrText.trim() : "";
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${ts} | worktree-${action}-failed | worktree=${worktreePath} | stderr=${stderr}`;
}

/**
 * Extract the fields this module cares about from a raw SubagentStart /
 * SubagentStop hook payload, tolerating malformed input (empty stdin,
 * invalid JSON already having failed upstream, or a payload missing the
 * fields entirely). Never throws.
 *
 * @param {unknown} parsed the JSON-parsed hook payload, or `undefined`/`null`
 *   when parsing failed
 * @returns {{cwd: string|null, agentId: string|null}}
 */
export function extractSubagentEventFields(parsed) {
  const payload = /** @type {Record<string, unknown>} */ (
    parsed && typeof parsed === "object" ? parsed : {}
  );
  const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
  const agentId = typeof payload.agent_id === "string" ? payload.agent_id : null;
  return { cwd, agentId };
}

/**
 * Given parsed `git worktree list --porcelain` records (see
 * `scripts/lib/worktrees-prune-core.mjs`'s `parseWorktrees`) and the resolved
 * main root, select the paths of every LOCKED agent isolation worktree —
 * exactly the set the SessionStart reaper should unlock. Non-agent worktrees
 * and unlocked agent worktrees are left alone.
 *
 * @param {Array<{path?: unknown, locked?: unknown}>} records
 * @param {unknown} mainRoot
 * @returns {string[]}
 */
export function selectLockedAgentWorktrees(records, mainRoot) {
  if (!Array.isArray(records)) return [];
  /** @type {string[]} */
  const paths = [];
  for (const record of records) {
    if (!record || record.locked !== true) continue;
    if (typeof record.path !== "string") continue;
    if (isAgentWorktreePath(record.path, mainRoot)) paths.push(record.path);
  }
  return paths;
}

/**
 * Decide whether a SessionStart-reaped candidate lock should actually be
 * unlocked, given its resolved {@link module:worktrees-prune-core.ActivityState}
 * (Issue #992 follow-up, fixing the Issue #997 regression).
 *
 * `selectLockedAgentWorktrees` only tells us a worktree IS a locked agent
 * worktree — it says nothing about whether the agent that locked it is still
 * alive. The prior SessionStart reaper unlocked every candidate
 * unconditionally on the premise that "no subagent is running yet within
 * THIS session, so this cannot race a live lock" — true within one session,
 * but false across concurrent sessions: this repo routinely runs several
 * Claude Code sessions at once, and a second session's SessionStart can fire
 * while a first session's agents are still actively working in a worktree it
 * locked. Unlocking that worktree let a subsequent `pnpm worktrees:prune`
 * delete in-flight work — exactly the failure Issue #992 exists to prevent.
 *
 * The fix: only reap a lock when its worktree demonstrably shows NO activity
 * within the window — i.e. `activity === "stale"`. Both `"fresh"` (recent
 * activity — a live agent, same or other session) and `"unknown"` (the
 * activity probe itself failed / was unreadable) must be treated as KEEP,
 * mirroring `resolveActivity`'s own fail-safe bias in
 * `scripts/lib/worktrees-prune-core.mjs`: an I/O error must never resolve
 * toward "delete"/"unlock".
 *
 * @param {object} args
 * @param {import("./worktrees-prune-core.mjs").ActivityState} args.activity
 * @returns {boolean} true only when `activity === "stale"` — a crashed agent
 *   that never fired `SubagentStop` to unlock its own worktree.
 */
export function shouldReapLock({ activity }) {
  return activity === "stale";
}
