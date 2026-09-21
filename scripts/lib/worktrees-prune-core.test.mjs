import { describe, it, expect } from "vitest";
import {
  AGENT_BRANCH_PREFIX,
  AGENT_MEMORY_PATH_PREFIX,
  AGENT_WORKTREE_MARKER,
  RECENT_ACTIVITY_WINDOW_MS,
  classifyRefreshOutcome,
  classifyWorktree,
  HELP_TEXT,
  isAgentWorktree,
  parseBranchesWithUpstream,
  parseFlags,
  parseGoneBranches,
  parseUnsavedAgentMemory,
  parseWorktrees,
  resolveActivity,
  resolveBranchGone,
  resolveHasUpstream,
  shouldPrune,
} from "./worktrees-prune-core.mjs";

const AGENT_PATH = `/repo/.claude/worktrees/agent-abc123`;
const HUMAN_PATH = `/repo/some-feature-worktree`;
const NOW = 1_800_000_000_000; // fixed reference instant for deterministic mtime math

describe("isAgentWorktree", () => {
  it("matches paths under the agent worktree marker", () => {
    expect(isAgentWorktree(AGENT_PATH)).toBe(true);
    expect(isAgentWorktree(`/x${AGENT_WORKTREE_MARKER}zzz`)).toBe(true);
  });

  it("rejects non-agent and non-string paths", () => {
    expect(isAgentWorktree(HUMAN_PATH)).toBe(false);
    expect(isAgentWorktree(undefined)).toBe(false);
    expect(isAgentWorktree(null)).toBe(false);
  });
});

describe("parseWorktrees", () => {
  it("parses a branch worktree and a detached + locked worktree", () => {
    const porcelain = [
      "worktree /repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /repo/.claude/worktrees/agent-1",
      "HEAD bbbb",
      "branch refs/heads/feature/x",
      "",
      "worktree /repo/.claude/worktrees/agent-2",
      "HEAD cccc",
      "detached",
      "locked reason here",
      "",
    ].join("\n");

    const records = parseWorktrees(porcelain);
    expect(records).toHaveLength(3);

    expect(records[0]).toMatchObject({ path: "/repo", branch: "main", detached: false });
    expect(records[1]).toMatchObject({
      path: "/repo/.claude/worktrees/agent-1",
      head: "bbbb",
      branch: "feature/x",
      detached: false,
      locked: false,
    });
    expect(records[2]).toMatchObject({
      path: "/repo/.claude/worktrees/agent-2",
      branch: null,
      detached: true,
      locked: true,
    });
  });

  it("handles the final record without a trailing blank line and CRLF endings", () => {
    const porcelain = "worktree /repo\r\nHEAD aaaa\r\nbranch refs/heads/main\r\nbare\r\n";
    const records = parseWorktrees(porcelain);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ path: "/repo", branch: "main", bare: true });
  });

  it("returns an empty array for empty or non-string input", () => {
    expect(parseWorktrees("")).toEqual([]);
    expect(parseWorktrees("   \n  ")).toEqual([]);
    expect(parseWorktrees(undefined)).toEqual([]);
  });

  it("ignores stray attribute lines that precede any worktree header", () => {
    const records = parseWorktrees(
      "HEAD orphan\nworktree /repo/.claude/worktrees/agent-1\nHEAD bbbb\n",
    );
    expect(records).toHaveLength(1);
    expect(records[0].path).toBe("/repo/.claude/worktrees/agent-1");
  });
});

describe("shouldPrune", () => {
  // These tests exercise the merge/branch-gone logic, not the mtime rule, so they
  // supply an explicit old mtimeMs/nowMs — omitting it would now hit the
  // fail-safe "unknown mtime → keep" guard (Issue #986 follow-up) and mask what
  // is actually under test here.
  const LEGACY_OLD_MTIME = NOW - RECENT_ACTIVITY_WINDOW_MS - 1;

  it("prunes a merged agent worktree", () => {
    expect(
      shouldPrune({
        path: AGENT_PATH,
        branch: "feature/x",
        isMerged: true,
        branchGone: false,
        mtimeMs: LEGACY_OLD_MTIME,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("prunes an agent worktree whose branch is gone", () => {
    expect(
      shouldPrune({
        path: AGENT_PATH,
        branch: "feature/x",
        isMerged: false,
        branchGone: true,
        mtimeMs: LEGACY_OLD_MTIME,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("infers branchGone from a null branch (detached) when not passed", () => {
    expect(
      shouldPrune({
        path: AGENT_PATH,
        branch: null,
        isMerged: false,
        mtimeMs: LEGACY_OLD_MTIME,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("never prunes the current worktree even when merged", () => {
    expect(
      shouldPrune({ path: AGENT_PATH, branch: "feature/x", isMerged: true, isCurrent: true }),
    ).toBe(false);
  });

  it("never prunes a non-agent path even when merged", () => {
    expect(shouldPrune({ path: HUMAN_PATH, branch: "feature/x", isMerged: true })).toBe(false);
  });

  it("keeps an unmerged, present agent worktree", () => {
    expect(
      shouldPrune({ path: AGENT_PATH, branch: "feature/x", isMerged: false, branchGone: false }),
    ).toBe(false);
  });

  it("defaults isMerged/isCurrent to safe values", () => {
    // Only path + a live branch supplied → not merged, present → keep.
    expect(shouldPrune({ path: AGENT_PATH, branch: "feature/x", branchGone: false })).toBe(false);
  });
});

describe("constants", () => {
  it("exposes the agent-branch prefix and idle window as named constants", () => {
    expect(AGENT_BRANCH_PREFIX).toBe("worktree-agent-");
    expect(RECENT_ACTIVITY_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
  });
});

describe("resolveActivity (Issue #986 follow-up: fail-safe mtime resolution)", () => {
  const WINDOW = RECENT_ACTIVITY_WINDOW_MS;

  it("returns fresh when the mtime is within the window", () => {
    expect(resolveActivity({ mtimeMs: NOW - WINDOW + 1, nowMs: NOW, windowMs: WINDOW })).toBe(
      "fresh",
    );
  });

  it("returns stale when the mtime is outside the window", () => {
    expect(resolveActivity({ mtimeMs: NOW - WINDOW - 1, nowMs: NOW, windowMs: WINDOW })).toBe(
      "stale",
    );
  });

  it("returns stale on ENOENT regardless of mtime — the directory is genuinely gone", () => {
    expect(
      resolveActivity({ mtimeMs: null, statErrorCode: "ENOENT", nowMs: NOW, windowMs: WINDOW }),
    ).toBe("stale");
  });

  it("returns unknown on a non-ENOENT stat error (EACCES)", () => {
    expect(
      resolveActivity({ mtimeMs: null, statErrorCode: "EACCES", nowMs: NOW, windowMs: WINDOW }),
    ).toBe("unknown");
  });

  it("returns unknown on an unrecognized stat error code", () => {
    expect(
      resolveActivity({ mtimeMs: null, statErrorCode: "UNKNOWN", nowMs: NOW, windowMs: WINDOW }),
    ).toBe("unknown");
  });

  it("returns unknown when mtime is null and there is no stat error code", () => {
    expect(resolveActivity({ mtimeMs: null, nowMs: NOW, windowMs: WINDOW })).toBe("unknown");
  });

  it("returns unknown when mtime is a non-number and there is no stat error code", () => {
    expect(resolveActivity({ mtimeMs: undefined, nowMs: NOW, windowMs: WINDOW })).toBe("unknown");
  });
});

describe("resolveActivity (Issue #992: gitdir-aware max(root, gitdir) signal)", () => {
  const WINDOW = RECENT_ACTIVITY_WINDOW_MS;
  const STALE_MTIME = NOW - WINDOW - 1;
  const FRESH_MTIME = NOW - WINDOW + 1;

  it("(a) nested-edit-only worktree: stale root mtime but a fresh gitdir index ⇒ fresh (kept)", () => {
    const result = resolveActivity({
      mtimeMs: STALE_MTIME,
      gitdirProbes: [
        { mtimeMs: FRESH_MTIME, statErrorCode: null }, // index
        { mtimeMs: STALE_MTIME, statErrorCode: null }, // HEAD
        { mtimeMs: null, statErrorCode: "ENOENT" }, // logs/HEAD absent
      ],
      nowMs: NOW,
      windowMs: WINDOW,
    });
    expect(result).toBe("fresh");
  });

  it("(b) genuinely idle worktree: both root and every gitdir probe are stale ⇒ still stale (prunable)", () => {
    const result = resolveActivity({
      mtimeMs: STALE_MTIME,
      gitdirProbes: [
        { mtimeMs: STALE_MTIME, statErrorCode: null },
        { mtimeMs: STALE_MTIME, statErrorCode: null },
        { mtimeMs: STALE_MTIME, statErrorCode: null },
      ],
      nowMs: NOW,
      windowMs: WINDOW,
    });
    expect(result).toBe("stale");
  });

  it("(c) missing/unreadable gitdir falls back to the root mtime, fail-safe", () => {
    const fresh = resolveActivity({
      mtimeMs: FRESH_MTIME,
      gitdirProbes: [
        { mtimeMs: null, statErrorCode: "ENOENT" },
        { mtimeMs: null, statErrorCode: "ENOENT" },
        { mtimeMs: null, statErrorCode: "ENOENT" },
      ],
      nowMs: NOW,
      windowMs: WINDOW,
    });
    expect(fresh).toBe("fresh");

    const stale = resolveActivity({
      mtimeMs: STALE_MTIME,
      gitdirProbes: [{ mtimeMs: null, statErrorCode: "EACCES" }],
      nowMs: NOW,
      windowMs: WINDOW,
    });
    expect(stale).toBe("stale");
  });

  it("gitdir probes alone (no readable root) still resolve activity — root EACCES, gitdir fresh", () => {
    const result = resolveActivity({
      mtimeMs: null,
      statErrorCode: "EACCES",
      gitdirProbes: [{ mtimeMs: FRESH_MTIME, statErrorCode: null }],
      nowMs: NOW,
      windowMs: WINDOW,
    });
    expect(result).toBe("fresh");
  });

  it("root ENOENT is the one legitimate exception — stale regardless of a fresh gitdir probe", () => {
    const result = resolveActivity({
      mtimeMs: null,
      statErrorCode: "ENOENT",
      gitdirProbes: [{ mtimeMs: FRESH_MTIME, statErrorCode: null }],
      nowMs: NOW,
      windowMs: WINDOW,
    });
    expect(result).toBe("stale");
  });

  it("returns unknown when the root fails non-ENOENT and no gitdir probe is readable", () => {
    const result = resolveActivity({
      mtimeMs: null,
      statErrorCode: "EACCES",
      gitdirProbes: [{ mtimeMs: null, statErrorCode: "ENOENT" }],
      nowMs: NOW,
      windowMs: WINDOW,
    });
    expect(result).toBe("unknown");
  });

  it("defaults gitdirProbes to [] — back-compatible with root-only #986 call sites", () => {
    expect(resolveActivity({ mtimeMs: FRESH_MTIME, nowMs: NOW, windowMs: WINDOW })).toBe("fresh");
  });
});

describe("resolveBranchGone", () => {
  it("is true when the worktree is detached, regardless of branch/goneBranches", () => {
    expect(resolveBranchGone({ detached: true, branch: null, goneBranches: new Set() })).toBe(true);
  });

  it("is true when the branch is present in goneBranches", () => {
    expect(
      resolveBranchGone({
        detached: false,
        branch: "feature/x",
        goneBranches: new Set(["feature/x"]),
      }),
    ).toBe(true);
  });

  it("is false when the branch is not detached and not in goneBranches", () => {
    expect(
      resolveBranchGone({
        detached: false,
        branch: "feature/x",
        goneBranches: new Set(["feature/y"]),
      }),
    ).toBe(false);
  });

  it("is false for an empty goneBranches set (e.g. a failed git call)", () => {
    expect(
      resolveBranchGone({ detached: false, branch: "feature/x", goneBranches: new Set() }),
    ).toBe(false);
  });
});

describe("resolveHasUpstream", () => {
  it("is true when the branch is present in branchesWithUpstream", () => {
    expect(
      resolveHasUpstream({
        branch: "feature/x",
        branchesWithUpstream: new Set(["feature/x"]),
      }),
    ).toBe(true);
  });

  it("is false when the branch is absent from branchesWithUpstream", () => {
    expect(
      resolveHasUpstream({
        branch: `${AGENT_BRANCH_PREFIX}abc123`,
        branchesWithUpstream: new Set(["feature/x"]),
      }),
    ).toBe(false);
  });

  it("is false for a null (detached) branch", () => {
    expect(resolveHasUpstream({ branch: null, branchesWithUpstream: new Set(["feature/x"]) })).toBe(
      false,
    );
  });

  it("is false for an empty branchesWithUpstream set (e.g. a failed git call)", () => {
    expect(resolveHasUpstream({ branch: "feature/x", branchesWithUpstream: new Set() })).toBe(
      false,
    );
  });
});

describe("classifyWorktree (Issue #986 safety rules)", () => {
  const AGENT_BRANCH = `${AGENT_BRANCH_PREFIX}xyz789`;
  const OLD_MTIME = NOW - RECENT_ACTIVITY_WINDOW_MS - 1;
  const FRESH_MTIME = NOW - RECENT_ACTIVITY_WINDOW_MS + 1;
  const BOUNDARY_MTIME = NOW - RECENT_ACTIVITY_WINDOW_MS; // exactly at the window edge → not recent

  it("(a) never prunes a locked worktree, even merged and forced", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      locked: true,
      isMerged: true,
      branchGone: true,
      hasUpstream: true,
      force: true,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "locked" });
  });

  it("(a) locked overrides even --force on an agent-branch-without-upstream worktree", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: AGENT_BRANCH,
      locked: true,
      hasUpstream: false,
      force: true,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result.prune).toBe(false);
    expect(result.reason).toBe("locked");
  });

  it("(b) does not prune a worktree-agent-* branch with no upstream by default", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: AGENT_BRANCH,
      hasUpstream: false,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "agent-branch-no-upstream" });
  });

  it("(b) prunes a worktree-agent-* branch with no upstream when --force is passed", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: AGENT_BRANCH,
      hasUpstream: false,
      force: true,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "forced-agent-branch-no-upstream" });
  });

  it("(b) an agent branch WITH an upstream is not treated as protected", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: AGENT_BRANCH,
      hasUpstream: true,
      branchGone: true,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "branch-gone" });
  });

  it("(b) defaults hasUpstream to false — an omitted field protects a worktree-agent-* branch", () => {
    // Regression guard: `hasUpstream` used to default to `true`, so a caller that
    // simply forgot the field silently re-armed the #986 bug. The safe default is
    // the inverse: omitting it must protect, never expose, the branch.
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: AGENT_BRANCH,
      branchGone: true,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "agent-branch-no-upstream" });
  });

  it("(c) does not prune a worktree with a recent (fresh) mtime", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: FRESH_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "recently-active" });
  });

  it("(c) prunes the equivalent worktree once its mtime is old enough", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "branch-gone" });
  });

  it("(c) treats the window boundary itself as old enough to prune", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: BOUNDARY_MTIME,
      nowMs: NOW,
    });
    expect(result.prune).toBe(true);
  });

  it("(c) --force bypasses the recently-active window", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      force: true,
      mtimeMs: FRESH_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "branch-gone" });
  });

  it("(c) ENOENT stat failure is the one legitimate exception — prune-eligible", () => {
    // The worktree directory genuinely no longer exists; nothing left to protect.
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: null,
      statErrorCode: "ENOENT",
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "branch-gone" });
  });

  it("(c) an EACCES stat failure fails SAFE — keeps the worktree", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: null,
      statErrorCode: "EACCES",
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "mtime-unknown" });
  });

  it("(c) an unrecognized stat error code also fails SAFE — keeps the worktree", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: null,
      statErrorCode: "EMFILE",
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "mtime-unknown" });
  });

  it("(c) a null mtime with no stat error code fails SAFE — keeps the worktree", () => {
    // Defensive case: stat "succeeded" but yielded no usable mtime and no error.
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: null,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "mtime-unknown" });
  });

  it("(c) --force bypasses the mtime-unknown protection too", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: null,
      statErrorCode: "EACCES",
      force: true,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "branch-gone" });
  });

  it("(c/#992) keeps a worktree with a stale root mtime but a fresh gitdir index (nested-edit-only agent)", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: OLD_MTIME,
      gitdirProbes: [{ mtimeMs: FRESH_MTIME, statErrorCode: null }],
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "recently-active" });
  });

  it("(c/#992) prunes a genuinely idle worktree — root AND every gitdir probe are stale", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: OLD_MTIME,
      gitdirProbes: [
        { mtimeMs: OLD_MTIME, statErrorCode: null },
        { mtimeMs: null, statErrorCode: "ENOENT" },
      ],
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "branch-gone" });
  });

  it("(c/#992) a missing/unreadable gitdir falls back to the root mtime, fail-safe", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      branchGone: true,
      mtimeMs: FRESH_MTIME,
      gitdirProbes: [
        { mtimeMs: null, statErrorCode: "ENOENT" },
        { mtimeMs: null, statErrorCode: "EACCES" },
      ],
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "recently-active" });
  });

  it("(d) still prunes a genuinely merged-and-stale real feature branch (#916 regression guard)", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/issue-982-985-impact-export-presentation",
      hasUpstream: true,
      isMerged: true,
      branchGone: false,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "merged-into-main" });
  });

  it("(d) still prunes a real feature branch whose upstream is [gone] (squash-merge + --delete-branch)", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/issue-982-985-impact-export-presentation",
      hasUpstream: true,
      isMerged: false,
      branchGone: true,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "branch-gone" });
  });

  it("(e) prunes a detached, old, unlocked agent worktree", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: null,
      branchGone: true,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: true, reason: "branch-gone" });
  });

  it("never evaluates a non-agent worktree", () => {
    const result = classifyWorktree({ path: HUMAN_PATH, branch: "feature/x", isMerged: true });
    expect(result).toEqual({ prune: false, reason: "not-an-agent-worktree" });
  });

  it("never prunes the current worktree, even forced", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      isCurrent: true,
      isMerged: true,
      branchGone: true,
      force: true,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "current-worktree" });
  });

  it("keeps an unmerged, present, non-agent-branch worktree", () => {
    const result = classifyWorktree({
      path: AGENT_PATH,
      branch: "feature/x",
      isMerged: false,
      branchGone: false,
      mtimeMs: OLD_MTIME,
      nowMs: NOW,
    });
    expect(result).toEqual({ prune: false, reason: "active" });
  });
});

describe("shouldPrune (thin boolean wrapper over classifyWorktree)", () => {
  it("mirrors classifyWorktree.prune — locked stays unpruned even with legacy-only args", () => {
    expect(
      shouldPrune({ path: AGENT_PATH, branch: "feature/x", locked: true, isMerged: true }),
    ).toBe(false);
  });

  it("stays back-compatible with the original #916 call signature", () => {
    // An explicit old mtime keeps this focused on the merge/branch-gone logic under
    // test; omitting it now hits the fail-safe "unknown mtime → keep" guard.
    expect(
      shouldPrune({
        path: AGENT_PATH,
        branch: "feature/x",
        isMerged: true,
        branchGone: false,
        mtimeMs: NOW - RECENT_ACTIVITY_WINDOW_MS - 1,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it("a worktree-agent-* record with hasUpstream OMITTED is NOT pruned (fail-safe default)", () => {
    expect(
      shouldPrune({
        path: AGENT_PATH,
        branch: `${AGENT_BRANCH_PREFIX}abc123`,
        branchGone: true,
        mtimeMs: NOW - RECENT_ACTIVITY_WINDOW_MS - 1,
        nowMs: NOW,
      }),
    ).toBe(false);
  });
});

describe("parseUnsavedAgentMemory (Issue #1147)", () => {
  const MEM = `${AGENT_MEMORY_PATH_PREFIX}code-issue`;

  it("collects untracked, unstaged and staged agent-memory paths", () => {
    const porcelain = [
      `?? ${MEM}/project_new-thing.md`,
      ` M ${MEM}/MEMORY.md`,
      `A  ${MEM}/feedback_x.md`,
      `MM ${MEM}/project_y.md`,
      ` D ${MEM}/project_gone.md`,
      "",
    ].join("\n");

    expect(parseUnsavedAgentMemory(porcelain)).toEqual([
      `${MEM}/project_new-thing.md`,
      `${MEM}/MEMORY.md`,
      `${MEM}/feedback_x.md`,
      `${MEM}/project_y.md`,
      `${MEM}/project_gone.md`,
    ]);
  });

  it("reports the destination of a rename, since that is the file at risk", () => {
    const porcelain = `R  ${MEM}/old_name.md -> ${MEM}/new_name.md`;
    expect(parseUnsavedAgentMemory(porcelain)).toEqual([`${MEM}/new_name.md`]);
  });

  it("strips the quotes git adds around paths with unusual characters", () => {
    const porcelain = `?? "${MEM}/a file.md"`;
    expect(parseUnsavedAgentMemory(porcelain)).toEqual([`${MEM}/a file.md`]);
  });

  it("ignores paths outside the agent-memory prefix", () => {
    const porcelain = [
      "?? server/src/lib/thing.ts",
      " M CHANGELOG.md",
      `?? .claude/agents/code-issue.md`,
      `?? ${MEM}/kept.md`,
    ].join("\n");
    expect(parseUnsavedAgentMemory(porcelain)).toEqual([`${MEM}/kept.md`]);
  });

  it("ignores `!!` ignored entries and truncated lines", () => {
    const porcelain = [`!! ${MEM}/ignored.md`, "??", "?? ", ""].join("\n");
    expect(parseUnsavedAgentMemory(porcelain)).toEqual([]);
  });

  it("de-duplicates a path reported twice", () => {
    const porcelain = [` M ${MEM}/MEMORY.md`, `?? ${MEM}/MEMORY.md`].join("\n");
    expect(parseUnsavedAgentMemory(porcelain)).toEqual([`${MEM}/MEMORY.md`]);
  });

  it("returns an empty list for clean, empty or non-string input", () => {
    expect(parseUnsavedAgentMemory("")).toEqual([]);
    expect(parseUnsavedAgentMemory("   \n  ")).toEqual([]);
    expect(parseUnsavedAgentMemory(undefined)).toEqual([]);
    expect(parseUnsavedAgentMemory(null)).toEqual([]);
  });
});

describe("classifyWorktree (Issue #1147 agent-memory guard)", () => {
  const OLD_MTIME = NOW - RECENT_ACTIVITY_WINDOW_MS - 1;
  const FRESH_MTIME = NOW - RECENT_ACTIVITY_WINDOW_MS + 1;
  const PENDING = [`${AGENT_MEMORY_PATH_PREFIX}code-issue/project_thing.md`];

  /** An otherwise unambiguously prunable worktree: real branch, merged, idle. */
  const prunable = (overrides) => ({
    path: AGENT_PATH,
    branch: "feature/issue-1147-codify-practices",
    hasUpstream: true,
    isMerged: true,
    mtimeMs: OLD_MTIME,
    nowMs: NOW,
    ...overrides,
  });

  it("refuses to prune a worktree holding uncommitted agent memory", () => {
    const result = classifyWorktree(prunable({ unsavedAgentMemory: PENDING }));
    expect(result).toEqual({ prune: false, reason: "unsaved-agent-memory" });
  });

  it("refuses when the memory probe could not run at all (null → fail safe)", () => {
    const result = classifyWorktree(prunable({ unsavedAgentMemory: null }));
    expect(result).toEqual({ prune: false, reason: "agent-memory-status-unknown" });
  });

  it("--force overrides the guard so a stuck worktree is never unprunable", () => {
    expect(classifyWorktree(prunable({ unsavedAgentMemory: PENDING, force: true }))).toEqual({
      prune: true,
      reason: "merged-into-main",
    });
    expect(classifyWorktree(prunable({ unsavedAgentMemory: null, force: true }))).toEqual({
      prune: true,
      reason: "merged-into-main",
    });
  });

  it("ranks above the activity window — pending memory is the actionable reason", () => {
    const result = classifyWorktree(
      prunable({ mtimeMs: FRESH_MTIME, unsavedAgentMemory: PENDING }),
    );
    expect(result).toEqual({ prune: false, reason: "unsaved-agent-memory" });
  });

  it("stays below `locked` and `current-worktree`, which nothing overrides", () => {
    expect(
      classifyWorktree(prunable({ locked: true, unsavedAgentMemory: PENDING, force: true })).reason,
    ).toBe("locked");
    expect(
      classifyWorktree(prunable({ isCurrent: true, unsavedAgentMemory: PENDING, force: true }))
        .reason,
    ).toBe("current-worktree");
  });

  it("does not fire for a non-agent worktree", () => {
    expect(classifyWorktree(prunable({ path: HUMAN_PATH, unsavedAgentMemory: PENDING }))).toEqual({
      prune: false,
      reason: "not-an-agent-worktree",
    });
  });

  it("changes nothing when there is no pending memory, omitted or explicit", () => {
    // Regression guard for the four pre-existing safety rules: the new field
    // defaults to "nothing unsaved", so every pre-#1147 call site is unaffected.
    expect(classifyWorktree(prunable({}))).toEqual({ prune: true, reason: "merged-into-main" });
    expect(classifyWorktree(prunable({ unsavedAgentMemory: [] }))).toEqual({
      prune: true,
      reason: "merged-into-main",
    });
    expect(shouldPrune(prunable({ unsavedAgentMemory: PENDING }))).toBe(false);
  });
});

describe("parseGoneBranches", () => {
  it("collects only branches whose upstream is [gone]", () => {
    const output = [
      "main ",
      "feature/x [gone]",
      "feature/y [ahead 2]",
      "chore/z [ahead 1, behind 3]",
      "feature/w [behind 4]",
      "another/gone-one [gone]",
      "",
    ].join("\n");

    const gone = parseGoneBranches(output);
    expect(gone).toBeInstanceOf(Set);
    expect([...gone].sort()).toEqual(["another/gone-one", "feature/x"]);
    expect(gone.has("main")).toBe(false);
    expect(gone.has("feature/y")).toBe(false);
  });

  it("handles CRLF line endings and a missing trailing newline", () => {
    const gone = parseGoneBranches("main \r\nfeature/x [gone]");
    expect([...gone]).toEqual(["feature/x"]);
  });

  it("returns an empty set for empty or non-string input", () => {
    expect(parseGoneBranches("")).toEqual(new Set());
    expect(parseGoneBranches("   \n ")).toEqual(new Set());
    expect(parseGoneBranches(undefined)).toEqual(new Set());
  });
});

describe("classifyRefreshOutcome", () => {
  it("reports a clean fetch with no message", () => {
    expect(classifyRefreshOutcome({ fetchOk: true })).toEqual({
      status: "fetched",
      warn: false,
      message: null,
    });
  });

  it("falls back to an offline remote-prune with an informational message", () => {
    const result = classifyRefreshOutcome({ fetchOk: false, remotePruneOk: true });
    expect(result.status).toBe("pruned");
    expect(result.warn).toBe(false);
    expect(result.message).toMatch(/pruned stale remote refs offline/);
  });

  it("warns and continues when both attempts fail", () => {
    const result = classifyRefreshOutcome({ fetchOk: false, remotePruneOk: false });
    expect(result.status).toBe("warn");
    expect(result.warn).toBe(true);
    expect(result.message).toMatch(/could not refresh remote-tracking refs/);
  });

  it("defaults remotePruneOk to false (warn) when the fetch failed", () => {
    expect(classifyRefreshOutcome({ fetchOk: false }).status).toBe("warn");
  });
});

describe("parseBranchesWithUpstream", () => {
  it("collects only branches that have a configured upstream", () => {
    const output = [
      `${AGENT_BRANCH_PREFIX}xyz789 `,
      "feature/x refs/remotes/origin/feature/x",
      "main refs/remotes/origin/main",
      `${AGENT_BRANCH_PREFIX}abc123 `,
      "",
    ].join("\n");

    const withUpstream = parseBranchesWithUpstream(output);
    expect(withUpstream).toBeInstanceOf(Set);
    expect([...withUpstream].sort()).toEqual(["feature/x", "main"]);
    expect(withUpstream.has(`${AGENT_BRANCH_PREFIX}xyz789`)).toBe(false);
    expect(withUpstream.has(`${AGENT_BRANCH_PREFIX}abc123`)).toBe(false);
  });

  it("handles CRLF line endings and a missing trailing newline", () => {
    const withUpstream = parseBranchesWithUpstream(
      "feature/x refs/remotes/origin/feature/x\r\nworktree-agent-z ",
    );
    expect([...withUpstream]).toEqual(["feature/x"]);
  });

  it("returns an empty set for empty, whitespace-only, or non-string input", () => {
    expect(parseBranchesWithUpstream("")).toEqual(new Set());
    expect(parseBranchesWithUpstream("   \n ")).toEqual(new Set());
    expect(parseBranchesWithUpstream(undefined)).toEqual(new Set());
  });

  it("ignores lines with no space separator at all", () => {
    expect(parseBranchesWithUpstream("malformed-line-no-space")).toEqual(new Set());
  });
});

describe("parseFlags", () => {
  it("defaults to a dry run with nothing applied", () => {
    expect(parseFlags([])).toEqual({
      apply: false,
      yes: false,
      force: false,
      dryRun: true,
      help: false,
    });
  });

  it("--yes applies the prune", () => {
    expect(parseFlags(["--yes"])).toMatchObject({ apply: true, yes: true, dryRun: false });
  });

  it("--force applies the prune and sets the force flag", () => {
    expect(parseFlags(["--force"])).toMatchObject({
      apply: true,
      force: true,
      dryRun: false,
    });
  });

  it("--dry-run is accepted as an explicit no-op alias", () => {
    expect(parseFlags(["--dry-run"])).toMatchObject({ apply: false, dryRun: true });
  });

  it("--dry-run wins over --yes and --force when combined (safety-first)", () => {
    expect(parseFlags(["--yes", "--dry-run"])).toMatchObject({ apply: false, dryRun: true });
    expect(parseFlags(["--force", "--dry-run"])).toMatchObject({ apply: false, dryRun: true });
  });

  it("recognizes --help and -h", () => {
    expect(parseFlags(["--help"]).help).toBe(true);
    expect(parseFlags(["-h"]).help).toBe(true);
    expect(parseFlags([]).help).toBe(false);
  });

  it("handles non-array input defensively", () => {
    expect(parseFlags(undefined)).toEqual({
      apply: false,
      yes: false,
      force: false,
      dryRun: true,
      help: false,
    });
  });
});

describe("HELP_TEXT", () => {
  it("documents every flag and all four safety rules", () => {
    expect(HELP_TEXT).toContain("--dry-run");
    expect(HELP_TEXT).toContain("--yes");
    expect(HELP_TEXT).toContain("--force");
    expect(HELP_TEXT).toContain("--help");
    expect(HELP_TEXT.toLowerCase()).toContain("locked");
    expect(HELP_TEXT).toContain(AGENT_BRANCH_PREFIX);
    expect(HELP_TEXT.toLowerCase()).toMatch(/recently.active|idle/);
  });

  it("documents the agent-memory rule and cites where it came from (Issue #1147)", () => {
    expect(HELP_TEXT).toContain(AGENT_MEMORY_PATH_PREFIX);
    expect(HELP_TEXT).toContain("#1147");
    expect(HELP_TEXT).toContain("#1140");
  });
});
