---
issue: 800
section: Changed
---

- Internal: the finding publisher behind Deep Dive → GitHub/Jira and Impact Analysis → Jira
  publishing now lives with the rest of publishing instead of inside the bug scanner. Nothing
  changes for users: issues get the same labels, bodies and audit entries, already-published
  issues are still recognised, and a GitHub publish with no target is still refused.
