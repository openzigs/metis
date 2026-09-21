import { describe, it, expect } from "vitest";
import {
  AGENT_DIR_PREFIX,
  buildLockFailureLogLine,
  buildLockReason,
  extractSubagentEventFields,
  isAgentWorktreePath,
  isTolerableLockError,
  isTolerableUnlockError,
  resolveMainRoot,
  resolveMainRootFromGitCommonDir,
  selectLockedAgentWorktrees,
  shouldReapLock,
} from "./agent-worktree-lock-core.mjs";
import { RECENT_ACTIVITY_WINDOW_MS, resolveActivity } from "./worktrees-prune-core.mjs";

const MAIN_ROOT = "/Users/dev/metis";
const AGENT_PATH = `${MAIN_ROOT}/.claude/worktrees/agent-abc123`;

describe("AGENT_DIR_PREFIX", () => {
  it("is the literal agent- worktree directory prefix", () => {
    expect(AGENT_DIR_PREFIX).toBe("agent-");
  });
});

describe("isAgentWorktreePath", () => {
  it("matches an absolute path inside <mainRoot>/.claude/worktrees/agent-*", () => {
    expect(isAgentWorktreePath(AGENT_PATH, MAIN_ROOT)).toBe(true);
  });

  it("matches a relative path resolved against mainRoot", () => {
    expect(isAgentWorktreePath(".claude/worktrees/agent-abc123", MAIN_ROOT)).toBe(true);
  });

  it("rejects a path outside .claude/worktrees entirely", () => {
    expect(isAgentWorktreePath(`${MAIN_ROOT}/server/src/index.ts`, MAIN_ROOT)).toBe(false);
  });

  it("rejects a sibling directory that merely starts with the same prefix string (worktrees-backup)", () => {
    expect(
      isAgentWorktreePath(`${MAIN_ROOT}/.claude/worktrees-backup/agent-abc123`, MAIN_ROOT),
    ).toBe(false);
  });

  it("rejects a sibling directory that merely starts with the same prefix string (worktrees2)", () => {
    expect(isAgentWorktreePath(`${MAIN_ROOT}/.claude/worktrees2/agent-abc123`, MAIN_ROOT)).toBe(
      false,
    );
  });

  it("rejects a non-agent worktree under .claude/worktrees (e.g. a human worktree)", () => {
    expect(isAgentWorktreePath(`${MAIN_ROOT}/.claude/worktrees/some-human-branch`, MAIN_ROOT)).toBe(
      false,
    );
  });

  it("rejects a directory under .claude/worktrees that is only a prefix of 'agent-' without the dash", () => {
    expect(isAgentWorktreePath(`${MAIN_ROOT}/.claude/worktrees/agentless`, MAIN_ROOT)).toBe(false);
  });

  it("normalizes a trailing slash on the cwd", () => {
    expect(isAgentWorktreePath(`${AGENT_PATH}/`, MAIN_ROOT)).toBe(true);
  });

  it("normalizes .. segments that still resolve inside the agent worktree", () => {
    expect(
      isAgentWorktreePath(`${MAIN_ROOT}/.claude/worktrees/other/../agent-abc123`, MAIN_ROOT),
    ).toBe(true);
  });

  it("normalizes .. segments that resolve OUTSIDE the agent worktree", () => {
    expect(isAgentWorktreePath(`${AGENT_PATH}/../../../etc/passwd`, MAIN_ROOT)).toBe(false);
  });

  it("treats backslash separators (Windows-style) the same as forward slashes", () => {
    expect(isAgentWorktreePath("C:\\repo\\.claude\\worktrees\\agent-xyz", "C:\\repo")).toBe(true);
  });

  it("rejects when mainRoot is not a prefix of cwd at all", () => {
    expect(isAgentWorktreePath("/other/place/.claude/worktrees/agent-abc123", MAIN_ROOT)).toBe(
      false,
    );
  });

  it("returns false for non-string cwd", () => {
    expect(isAgentWorktreePath(undefined, MAIN_ROOT)).toBe(false);
    expect(isAgentWorktreePath(null, MAIN_ROOT)).toBe(false);
    expect(isAgentWorktreePath(42, MAIN_ROOT)).toBe(false);
  });

  it("returns false for empty string cwd", () => {
    expect(isAgentWorktreePath("", MAIN_ROOT)).toBe(false);
  });

  it("returns false for non-string or empty mainRoot", () => {
    expect(isAgentWorktreePath(AGENT_PATH, undefined)).toBe(false);
    expect(isAgentWorktreePath(AGENT_PATH, "")).toBe(false);
  });

  it("returns false when cwd is too shallow to contain the full marker", () => {
    expect(isAgentWorktreePath(`${MAIN_ROOT}/.claude`, MAIN_ROOT)).toBe(false);
  });

  it("returns false when mainRoot normalizes to no segments at all (only separators)", () => {
    expect(isAgentWorktreePath(AGENT_PATH, "///")).toBe(false);
  });

  it("returns false when a same-depth cwd diverges from mainRoot partway through the prefix", () => {
    // Same segment count as a real match, but the second segment mismatches
    // mainRoot — must fail inside the prefix-comparison loop, not merely on
    // the length guard.
    expect(isAgentWorktreePath("/Users/other/metis/.claude/worktrees/agent-x", MAIN_ROOT)).toBe(
      false,
    );
  });
});

describe("resolveMainRootFromGitCommonDir", () => {
  it("strips a trailing /.git with no newline", () => {
    expect(resolveMainRootFromGitCommonDir("/Users/dev/metis/.git")).toBe("/Users/dev/metis");
  });

  it("strips a trailing /.git WITH a trailing newline (real execFileSync shape)", () => {
    expect(resolveMainRootFromGitCommonDir("/Users/dev/metis/.git\n")).toBe("/Users/dev/metis");
  });

  it("strips a trailing \\.git (Windows-style)", () => {
    expect(resolveMainRootFromGitCommonDir("C:\\repo\\.git")).toBe("C:/repo");
  });

  it("returns null for null/undefined input", () => {
    expect(resolveMainRootFromGitCommonDir(null)).toBeNull();
    expect(resolveMainRootFromGitCommonDir(undefined)).toBeNull();
  });

  it("returns null for empty/whitespace-only input", () => {
    expect(resolveMainRootFromGitCommonDir("")).toBeNull();
    expect(resolveMainRootFromGitCommonDir("   \n")).toBeNull();
  });

  it("returns null when the output doesn't end in .git at all", () => {
    expect(resolveMainRootFromGitCommonDir("/Users/dev/metis")).toBeNull();
  });
});

describe("resolveMainRoot", () => {
  it("prefers --git-common-dir output when run from inside a worktree (the #992 bug)", () => {
    // The exact failure mode being fixed: --show-toplevel from inside a
    // worktree returns the WORKTREE root, but --git-common-dir still points
    // at the MAIN repo's .git. resolveMainRoot must prefer the latter.
    const worktreeToplevel = "/Users/dev/metis/.claude/worktrees/agent-abc123\n";
    const gitCommonDir = "/Users/dev/metis/.git\n";
    const result = resolveMainRoot({
      gitCommonDirOutput: gitCommonDir,
      showToplevelOutput: worktreeToplevel,
    });
    expect(result).toBe("/Users/dev/metis");
    expect(result).not.toBe(resolveMainRoot({ showToplevelOutput: worktreeToplevel }));
  });

  it("prefers --git-common-dir without a trailing newline too", () => {
    const result = resolveMainRoot({
      gitCommonDirOutput: "/Users/dev/metis/.git",
      showToplevelOutput: "/Users/dev/metis/.claude/worktrees/agent-abc123",
    });
    expect(result).toBe("/Users/dev/metis");
  });

  it("falls back to --show-toplevel when --git-common-dir failed", () => {
    const result = resolveMainRoot({
      gitCommonDirOutput: null,
      showToplevelOutput: "/Users/dev/metis\n",
    });
    expect(result).toBe("/Users/dev/metis");
  });

  it("returns null when both invocations failed", () => {
    expect(resolveMainRoot({ gitCommonDirOutput: null, showToplevelOutput: null })).toBeNull();
  });

  it("returns null when called with no args at all", () => {
    expect(resolveMainRoot()).toBeNull();
  });

  it("returns null when --show-toplevel fallback is whitespace-only", () => {
    expect(resolveMainRoot({ gitCommonDirOutput: null, showToplevelOutput: "   \n" })).toBeNull();
  });
});

describe("buildLockReason", () => {
  it("embeds the agent id", () => {
    expect(buildLockReason("a5c8113a")).toBe("agent a5c8113a active");
  });

  it("falls back to 'unknown' for a missing/non-string agent id", () => {
    expect(buildLockReason(undefined)).toBe("agent unknown active");
    expect(buildLockReason(null)).toBe("agent unknown active");
    expect(buildLockReason(42)).toBe("agent unknown active");
    expect(buildLockReason("")).toBe("agent unknown active");
  });
});

describe("isTolerableLockError", () => {
  it("tolerates an already-locked stderr message", () => {
    expect(isTolerableLockError("fatal: '/repo/.claude/worktrees/agent-x' is already locked")).toBe(
      true,
    );
  });

  it("is case-insensitive", () => {
    expect(isTolerableLockError("Already Locked, reason: foo")).toBe(true);
  });

  it("does not tolerate an unrelated git error", () => {
    expect(isTolerableLockError("fatal: not a working tree")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isTolerableLockError(undefined)).toBe(false);
    expect(isTolerableLockError(null)).toBe(false);
  });
});

describe("isTolerableUnlockError", () => {
  it("tolerates a not-locked stderr message", () => {
    expect(isTolerableUnlockError("fatal: '/repo/.claude/worktrees/agent-x' is not locked")).toBe(
      true,
    );
  });

  it("tolerates a worktree whose directory is already gone", () => {
    expect(isTolerableUnlockError("fatal: No such file or directory")).toBe(true);
  });

  it("tolerates a worktree already removed from git's admin files", () => {
    expect(isTolerableUnlockError("fatal: '/repo/x' is not a working tree")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isTolerableUnlockError("NOT LOCKED")).toBe(true);
  });

  it("does not tolerate an unrelated git error", () => {
    expect(isTolerableUnlockError("fatal: permission denied")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isTolerableUnlockError(undefined)).toBe(false);
    expect(isTolerableUnlockError(null)).toBe(false);
  });
});

describe("buildLockFailureLogLine (Issue #992 follow-up: predicates actually gate behavior)", () => {
  it("returns null for a tolerable SubagentStart (lock) failure — stays silent", () => {
    expect(
      buildLockFailureLogLine({
        event: "SubagentStart",
        cwd: AGENT_PATH,
        stderrText: "fatal: '/repo/.claude/worktrees/agent-x' is already locked",
      }),
    ).toBeNull();
  });

  it("returns null for a tolerable SubagentStop (unlock) failure — stays silent", () => {
    expect(
      buildLockFailureLogLine({
        event: "SubagentStop",
        cwd: AGENT_PATH,
        stderrText: "fatal: '/repo/.claude/worktrees/agent-x' is not locked",
      }),
    ).toBeNull();
  });

  it("returns a log line for a NON-tolerable SubagentStart (lock) failure, naming the event, worktree path, and stderr", () => {
    const line = buildLockFailureLogLine({
      event: "SubagentStart",
      cwd: AGENT_PATH,
      stderrText: "fatal: permission denied",
    });
    expect(line).not.toBeNull();
    expect(line).toContain("worktree-lock-failed");
    expect(line).toContain(`worktree=${AGENT_PATH}`);
    expect(line).toContain("stderr=fatal: permission denied");
  });

  it("returns a log line for a NON-tolerable SubagentStop (unlock) failure, naming the event, worktree path, and stderr", () => {
    const line = buildLockFailureLogLine({
      event: "SubagentStop",
      cwd: AGENT_PATH,
      stderrText: "fatal: permission denied",
    });
    expect(line).not.toBeNull();
    expect(line).toContain("worktree-unlock-failed");
    expect(line).toContain(`worktree=${AGENT_PATH}`);
    expect(line).toContain("stderr=fatal: permission denied");
  });

  it("falls back to worktree=unknown when cwd is not a string", () => {
    const line = buildLockFailureLogLine({
      event: "SubagentStart",
      cwd: undefined,
      stderrText: "fatal: permission denied",
    });
    expect(line).toContain("worktree=unknown");
  });

  it("trims whitespace from a non-tolerable stderr message", () => {
    const line = buildLockFailureLogLine({
      event: "SubagentStart",
      cwd: AGENT_PATH,
      stderrText: "  fatal: permission denied\n",
    });
    expect(line).toContain("stderr=fatal: permission denied");
    expect(line?.endsWith("\n")).toBe(false);
  });

  it("renders an empty stderr= field when stderrText is not a string", () => {
    const line = buildLockFailureLogLine({
      event: "SubagentStart",
      cwd: AGENT_PATH,
      stderrText: undefined,
    });
    // A non-string stderrText also fails isTolerableLockError (returns
    // false), so this is treated as non-tolerable and still logged, just
    // with an empty stderr field.
    expect(line).toContain("stderr=");
    expect(line).toContain("worktree-lock-failed");
  });
});

describe("extractSubagentEventFields", () => {
  it("extracts cwd and agent_id from a well-formed payload", () => {
    expect(extractSubagentEventFields({ cwd: AGENT_PATH, agent_id: "abc123" })).toEqual({
      cwd: AGENT_PATH,
      agentId: "abc123",
    });
  });

  it("returns nulls for a payload missing both fields", () => {
    expect(extractSubagentEventFields({ hook_event_name: "SubagentStart" })).toEqual({
      cwd: null,
      agentId: null,
    });
  });

  it("returns nulls for undefined (JSON.parse threw upstream / empty stdin)", () => {
    expect(extractSubagentEventFields(undefined)).toEqual({ cwd: null, agentId: null });
  });

  it("returns nulls for null", () => {
    expect(extractSubagentEventFields(null)).toEqual({ cwd: null, agentId: null });
  });

  it("returns nulls when the payload is not an object (malformed JSON top-level value)", () => {
    expect(extractSubagentEventFields("just a string")).toEqual({ cwd: null, agentId: null });
    expect(extractSubagentEventFields(42)).toEqual({ cwd: null, agentId: null });
  });

  it("ignores non-string cwd/agent_id values", () => {
    expect(extractSubagentEventFields({ cwd: 42, agent_id: {} })).toEqual({
      cwd: null,
      agentId: null,
    });
  });
});

describe("selectLockedAgentWorktrees", () => {
  it("selects only locked agent worktrees, skipping unlocked agent worktrees and non-agent entries", () => {
    const records = [
      { path: MAIN_ROOT, locked: false }, // main checkout, never touched
      { path: `${MAIN_ROOT}/.claude/worktrees/agent-locked-1`, locked: true },
      { path: `${MAIN_ROOT}/.claude/worktrees/agent-locked-2`, locked: true },
      { path: `${MAIN_ROOT}/.claude/worktrees/agent-unlocked`, locked: false },
      { path: `${MAIN_ROOT}/.claude/worktrees/human-branch`, locked: true },
      { path: `${MAIN_ROOT}/.claude/worktrees-backup/agent-decoy`, locked: true },
    ];
    expect(selectLockedAgentWorktrees(records, MAIN_ROOT)).toEqual([
      `${MAIN_ROOT}/.claude/worktrees/agent-locked-1`,
      `${MAIN_ROOT}/.claude/worktrees/agent-locked-2`,
    ]);
  });

  it("returns an empty array when there are no locked agent worktrees", () => {
    const records = [{ path: `${MAIN_ROOT}/.claude/worktrees/agent-x`, locked: false }];
    expect(selectLockedAgentWorktrees(records, MAIN_ROOT)).toEqual([]);
  });

  it("returns an empty array for a non-array input", () => {
    expect(selectLockedAgentWorktrees(undefined, MAIN_ROOT)).toEqual([]);
    expect(selectLockedAgentWorktrees(null, MAIN_ROOT)).toEqual([]);
  });

  it("tolerates malformed records without throwing", () => {
    const records = [null, undefined, {}, { locked: true }, { path: 123, locked: true }];
    expect(() => selectLockedAgentWorktrees(records, MAIN_ROOT)).not.toThrow();
    expect(selectLockedAgentWorktrees(records, MAIN_ROOT)).toEqual([]);
  });
});

describe("shouldReapLock", () => {
  it('reaps a lock only when activity is exactly "stale"', () => {
    expect(shouldReapLock({ activity: "stale" })).toBe(true);
  });

  it('does NOT reap a lock when activity is "fresh"', () => {
    expect(shouldReapLock({ activity: "fresh" })).toBe(false);
  });

  it('does NOT reap a lock when activity is "unknown" (fail-safe, matches resolveActivity\'s bias)', () => {
    expect(shouldReapLock({ activity: "unknown" })).toBe(false);
  });

  it("does not reap for any unrecognized/malformed activity value (fail-safe default)", () => {
    expect(shouldReapLock({ activity: undefined })).toBe(false);
    expect(shouldReapLock({ activity: null })).toBe(false);
    expect(shouldReapLock({ activity: "" })).toBe(false);
    expect(shouldReapLock({ activity: "STALE" })).toBe(false);
  });
});

describe("SessionStart reap gate (Issue #997 regression coverage)", () => {
  // Reproduces the exact pipeline session-start.mjs runs: select locked
  // agent-worktree candidates, resolve each one's real activity signal via
  // the same resolveActivity used by worktrees-prune.mjs, then gate the
  // unlock on shouldReapLock. These are the scenarios the pre-fix reaper got
  // wrong (or, for the non-agent case, could never have gotten wrong because
  // selection excludes it upstream of the activity check entirely).
  const NOW_MS = 1_700_000_000_000;

  it("does NOT reap a locked agent worktree with FRESH activity — the concurrent-session live-agent case (Issue #997 regression test)", () => {
    const records = [{ path: AGENT_PATH, locked: true }];
    const [candidate] = selectLockedAgentWorktrees(records, MAIN_ROOT);
    expect(candidate).toBe(AGENT_PATH);

    // A gitdir file touched 5 minutes ago — another session's agent is still
    // actively committing/checking out in this worktree.
    const activity = resolveActivity({
      mtimeMs: NOW_MS - 60 * 60 * 1000, // root dir itself looks idle (1h)
      statErrorCode: null,
      gitdirProbes: [{ mtimeMs: NOW_MS - 5 * 60 * 1000, statErrorCode: null }],
      nowMs: NOW_MS,
      windowMs: RECENT_ACTIVITY_WINDOW_MS,
    });
    expect(activity).toBe("fresh");
    expect(shouldReapLock({ activity })).toBe(false);
  });

  it("DOES reap a locked agent worktree with STALE activity — the crashed-agent case the reaper exists to solve", () => {
    const records = [{ path: AGENT_PATH, locked: true }];
    const [candidate] = selectLockedAgentWorktrees(records, MAIN_ROOT);
    expect(candidate).toBe(AGENT_PATH);

    // Root dir and every gitdir probe are all well outside the activity
    // window — the agent that locked this worktree crashed without ever
    // firing SubagentStop, and nothing has touched it since.
    const activity = resolveActivity({
      mtimeMs: NOW_MS - 6 * 60 * 60 * 1000,
      statErrorCode: null,
      gitdirProbes: [
        { mtimeMs: NOW_MS - 5 * 60 * 60 * 1000, statErrorCode: null },
        { mtimeMs: NOW_MS - 5.5 * 60 * 60 * 1000, statErrorCode: null },
      ],
      nowMs: NOW_MS,
      windowMs: RECENT_ACTIVITY_WINDOW_MS,
    });
    expect(activity).toBe("stale");
    expect(shouldReapLock({ activity })).toBe(true);
  });

  it('does NOT reap when activity resolves to "unknown" — every probe unreadable, fail-safe toward keep', () => {
    const records = [{ path: AGENT_PATH, locked: true }];
    const [candidate] = selectLockedAgentWorktrees(records, MAIN_ROOT);
    expect(candidate).toBe(AGENT_PATH);

    // Root stat failed with something other than ENOENT (e.g. EACCES), and
    // every gitdir probe also failed to read — no mtime evidence at all.
    const activity = resolveActivity({
      mtimeMs: null,
      statErrorCode: "EACCES",
      gitdirProbes: [
        { mtimeMs: null, statErrorCode: "ENOENT" },
        { mtimeMs: null, statErrorCode: "ENOENT" },
      ],
      nowMs: NOW_MS,
      windowMs: RECENT_ACTIVITY_WINDOW_MS,
    });
    expect(activity).toBe("unknown");
    expect(shouldReapLock({ activity })).toBe(false);
  });

  it("never selects a locked NON-agent worktree as a reap candidate, regardless of activity (selection boundary)", () => {
    const humanWorktree = `${MAIN_ROOT}/.claude/worktrees/some-human-branch`;
    const records = [{ path: humanWorktree, locked: true }];

    // The reaper never even reaches an activity check for this path — it is
    // filtered out at selection, before shouldReapLock is ever consulted.
    const candidates = selectLockedAgentWorktrees(records, MAIN_ROOT);
    expect(candidates).toEqual([]);

    // Even if it HAD been evaluated with maximally-stale activity, the
    // pipeline never calls shouldReapLock for a path outside the candidate
    // set — asserting the full round trip stays empty end to end.
    for (const path of candidates) {
      const activity = resolveActivity({
        mtimeMs: 0,
        statErrorCode: null,
        gitdirProbes: [],
        nowMs: NOW_MS,
        windowMs: RECENT_ACTIVITY_WINDOW_MS,
      });
      expect(shouldReapLock({ activity })).toBe(true); // unreachable: candidates is empty
    }
  });
});
