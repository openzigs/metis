---
issue: 2332
section: Changed
---

- Users who are not system admins no longer see the operations and developer pages: Tasks, Runs,
  Scheduler, Vault, Eval, and the Settings sections Configuration, MCP servers, ACP tokens, Hooks
  and Triggers. They are gone from the sidebar, the tab bars, the Settings pages and the command
  palette, and Activity opens on Sessions. Opening one by URL shows "You don't have access to this
  page" with a way back. Admins see every page as before.
- Reviews is now its own sidebar entry, with a count of the reviews waiting on you. The count
  updates when you are assigned a review or one is decided, and screen readers announce it.
  Old `/reviews` links still work.
- The Eval leaderboard's API reads (`GET /api/eval/leaderboard` and
  `/api/eval/leaderboard/runs/:id`) now require `admin.read`. They had required only a sign-in.
