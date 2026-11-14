---
issue: 2338
section: Added
---

- Chat can answer "when did this change, and why" with `get_change_history`, off by default
  behind `CHAT_CHANGE_HISTORY_TOOL` until measured: the commits that changed a file, some
  lines or a function, newest first, with date, message (secrets and e-mail addresses
  removed) and link, and whether older history exists. Local-folder and uploaded sources
  say they have no history. While on, each sync keeps the year of history before the
  indexed commit on the server (`REPO_HISTORY_MAX_BYTES`, `REPO_HISTORY_WINDOW_DAYS`).
