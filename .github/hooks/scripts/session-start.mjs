#!/usr/bin/env node
// Hook: SessionStart — Injects git context into every new agent session, and
// reaps DEMONSTRABLY DEAD agent-worktree locks (Issue #992, hardened after
// the Issue #997 regression).
//
// SubagentStart/SubagentStop (see subagent-log.mjs) lock/unlock an agent's
// isolation worktree for its whole lifetime so `pnpm worktrees:prune` never
// deletes it out from under an active agent. An agent that dies abnormally
// (crash, forced termination) without SubagentStop firing leaves its lock in
// place forever, which would otherwise make that worktree permanently
// un-prunable. SessionStart is a reasonable place to try to reap those — but
// ONLY the ones that are actually dead.
//
// The real invariant: "no subagent is running yet within THIS session" does
// NOT mean no subagent is running anywhere. This repo routinely runs several
// Claude Code sessions concurrently, and a second session's SessionStart can
// fire while a first session's agents are still actively working in a
// worktree it locked. Issue #997 was exactly this: unconditionally unlocking
// every `.claude/worktrees/agent-*` worktree here unlocked other sessions'
// live, in-flight worktrees, and a subsequent `pnpm worktrees:prune` deleted
// them — the very failure Issue #992 exists to prevent, reintroduced by the
// reaper meant to fix it.
//
// A lock is therefore reaped only when its worktree shows NO activity within
// the recent-activity window — the same gitdir-aware activity probe
// `scripts/worktrees-prune.mjs` uses for its own prune-eligibility decision
// (`resolveActivity` in worktrees-prune-core.mjs) — as decided by the pure
// `shouldReapLock` predicate in agent-worktree-lock-core.mjs. Both "fresh"
// (a live agent, this session or another) and "unknown" (the activity probe
// itself failed) mean KEEP the lock; only "stale" is reaped.
//
// Non-blocking: always exits 0, outputs systemMessage only. Reaping failures
// (for any single worktree, or as a whole) are swallowed — this must never
// fail session start.
// Cross-platform: runs on Windows, macOS, and Linux via Node.js.
import { execFileSync } from "child_process";

import {
  resolveMainRoot,
  selectLockedAgentWorktrees,
  shouldReapLock,
} from "../../../scripts/lib/agent-worktree-lock-core.mjs";
import {
  parseWorktrees,
  RECENT_ACTIVITY_WINDOW_MS,
  resolveActivity,
} from "../../../scripts/lib/worktrees-prune-core.mjs";
import { gitdirProbesFor, statInfo } from "../../../scripts/worktrees-prune.mjs";

function git(...args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD") ?? "detached";
const sha = git("rev-parse", "--short", "HEAD") ?? "unknown";
let dirty = "clean";
try {
  execFileSync("git", ["diff", "--quiet"], { stdio: "pipe" });
} catch {
  dirty = "dirty";
}
const lastCommit = git("log", "-1", "--format=%s") ?? "no commits";

try {
  const gitCommonDirOutput = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  const showToplevelOutput = git("rev-parse", "--show-toplevel");
  const mainRoot = resolveMainRoot({ gitCommonDirOutput, showToplevelOutput });
  const porcelain = git("worktree", "list", "--porcelain");
  if (mainRoot && porcelain) {
    const records = parseWorktrees(porcelain);
    const candidatePaths = selectLockedAgentWorktrees(records, mainRoot);
    // --path-format=absolute already yields an absolute path (or null on
    // failure); gitdirProbesFor treats a falsy commonGitDir as "no gitdir
    // probes available" and falls back to the root mtime alone, per
    // resolveActivity's fail-safe combination rules.
    const commonGitDir = gitCommonDirOutput ? gitCommonDirOutput.trim() : null;
    const nowMs = Date.now();
    for (const path of candidatePaths) {
      try {
        const { mtimeMs, statErrorCode } = statInfo(path);
        const gitdirProbes = gitdirProbesFor(commonGitDir, path);
        const activity = resolveActivity({
          mtimeMs,
          statErrorCode,
          gitdirProbes,
          nowMs,
          windowMs: RECENT_ACTIVITY_WINDOW_MS,
        });
        if (!shouldReapLock({ activity })) continue;
        execFileSync("git", ["worktree", "unlock", path], { stdio: "pipe" });
      } catch {
        // Probing or unlocking a single worktree failed (already unlocked,
        // worktree gone, transient git/fs error) — skip it and keep
        // processing the rest; this must never fail session start.
      }
    }
  }
} catch {
  // Reaping is best-effort; never let it block session start.
}

process.stdout.write(
  JSON.stringify({
    continue: true,
    systemMessage: `Session context — branch: ${branch}, commit: ${sha} (${dirty}), last: ${lastCommit}`,
  }) + "\n",
);
