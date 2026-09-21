#!/usr/bin/env node
// Hook: SubagentStart / SubagentStop — Logs subagent lifecycle and locks/unlocks
// the agent's isolation worktree for its whole life (Issue #992, follow-up to
// #986 / #916): `git worktree lock` is the one unconditional, unoverridable
// guard `pnpm worktrees:prune` respects, so every isolation worktree must be
// locked from SubagentStart through SubagentStop regardless of which branch
// it later checks out.
//
// Also fixes a log-destination bug: resolving the repo root via
// `git rev-parse --show-toplevel` returns the WORKTREE root when this hook
// runs from inside a worktree (which it always does for a subagent), so
// lifecycle logs landed in `<worktree>/.github/hooks/logs/` and were deleted
// with the worktree. `resolveMainRoot` prefers `--git-common-dir`, which
// always points at the MAIN repo's `.git`.
//
// Non-blocking: always exits 0, never denies, never throws — a failure to
// lock/unlock or to log is swallowed, not surfaced.
// Cross-platform: runs on Windows, macOS, and Linux via Node.js.
import { execFileSync } from "child_process";
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";

import {
  buildLockFailureLogLine,
  buildLockReason,
  extractSubagentEventFields,
  isAgentWorktreePath,
  resolveMainRoot,
} from "../../../scripts/lib/agent-worktree-lock-core.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString();

let parsed;
try {
  parsed = JSON.parse(input);
} catch {}

// Handle both Copilot format (hookEventName/agentName) and Claude Code format
// (hook_event_name/agent_type), plus the Claude Code-only cwd/agent_id fields
// this hook needs for worktree locking.
const event = parsed?.hook_event_name ?? parsed?.hookEventName ?? "unknown";
const agent = parsed?.agent_type ?? parsed?.agentName ?? "unknown";
const { cwd, agentId } = extractSubagentEventFields(parsed);

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

let gitCommonDirOutput = null;
try {
  gitCommonDirOutput = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
} catch {}

let showToplevelOutput = null;
try {
  showToplevelOutput = git(["rev-parse", "--show-toplevel"]);
} catch {}

const mainRoot = resolveMainRoot({ gitCommonDirOutput, showToplevelOutput }) ?? ".";

const logDir = join(mainRoot, ".github", "hooks", "logs");
try {
  mkdirSync(logDir, { recursive: true });
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  appendFileSync(join(logDir, "subagent.log"), `${ts} | ${event} | agent=${agent}\n`);
} catch {}

// Lock (SubagentStart) / unlock (SubagentStop) the agent's isolation worktree
// for its whole lifetime, independent of which branch it later checks out.
if (cwd && isAgentWorktreePath(cwd, mainRoot)) {
  try {
    if (event === "SubagentStart") {
      git(["worktree", "lock", cwd, "--reason", buildLockReason(agentId)]);
    } else if (event === "SubagentStop") {
      git(["worktree", "unlock", cwd]);
    }
  } catch (err) {
    const stderrText = err?.stderr?.toString?.() ?? err?.message ?? "";
    // Swallow tolerable races (already locked / not locked / worktree gone)
    // silently, exactly as before. A NON-tolerable failure gets one
    // diagnostic line in the same lifecycle log (best-effort — a failure to
    // write it is swallowed too, so logging can never become a new failure
    // mode). Either way this hook must never surface an error.
    const logLine = buildLockFailureLogLine({ event, cwd, stderrText });
    if (logLine) {
      try {
        appendFileSync(join(logDir, "subagent.log"), `${logLine}\n`);
      } catch {}
    }
  }
}

process.stdout.write(JSON.stringify({ continue: true }) + "\n");
