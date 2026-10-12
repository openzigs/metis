---
name: pgrep-f-wait-loop-matches-itself
description: A shell wait loop built on pgrep -f with the pattern in its own command line matches itself and never exits; list real node processes with ps and grep instead.
metadata:
  type: project
---

A shell wait loop `while pgrep -fl "tsc|vitest" | grep -q metis` matches its own bash command line and never exits; match real processes with `ps -axo pid,command | grep -E "node .*(vitest|tsc)" | grep -v grep`.

**Why:** `pgrep -f` matches against the full command line of every process, and the loop's own `bash -c '… pgrep -fl "tsc|vitest" … metis …'` contains both the pattern and the word `metis`. The loop therefore always finds one process — itself — and waits forever for a gate that already finished. This cost a session an indefinite hang while waiting for other agents' test runs to clear.

**How to apply:**

- Before starting the full `pnpm lint && pnpm typecheck && pnpm test` gate on a shared machine, check once with `ps -axo pid,command | grep -E "node .*(vitest|tsc)" | grep -v grep`. Anchoring on `node ` excludes the shell that runs the check.
- Never `pkill` / `killall` by pattern for the same reason: the pattern matches other agents' processes.
- If a wait is needed, poll that `ps` line with a bounded number of attempts, not an open `while`.
