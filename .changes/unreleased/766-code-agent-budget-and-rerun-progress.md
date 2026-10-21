---
issue: 766
section: Fixed
---

- The code agent's transcript compaction no longer rewrites one message on every turn once its
  preserved results outweigh the target, so the prompt cache holds between compaction events and
  less of the token budget goes on re-sent input.
- A Regenerate or Continue shows on the agent's card while it runs: "Re-running", the code
  agent's tool calls so far, the elapsed time, and when it moves on to the run summary.
