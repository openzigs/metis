---
issue: 2488
section: Changed
---

- Chat answers "when did this change, and why" by default: `get_change_history`
  (`CHAT_CHANGE_HISTORY_TOOL`) is now on unless an administrator sets it to `false`. Measured
  on the BA question set, it took the when-and-why answers from 30% to 96% of their facts,
  with no other answer worse beyond run-to-run variation. While it is on, each sync of a
  GitHub or GitLab repository keeps the year of history before the indexed commit on the
  server (capped by `REPO_HISTORY_MAX_BYTES`); setting the key to `false` deletes it.
