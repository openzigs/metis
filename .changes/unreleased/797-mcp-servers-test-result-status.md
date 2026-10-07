---
issue: 797
section: Fixed
---

- **Settings → MCP → Servers** now shows the result of **Test** under the row: whether it passed,
  the latency, the number of tools, and the error message when it failed.
- After **Start**, **Stop**, **Restart** or **Test**, the row updates on its own (for example
  `starting` → `ready · 13`) instead of staying `idle · 0` until you reload. The page checks
  about once a second for up to 30 seconds and stops as soon as the status settles.
- The skill **Versions** dialog now shows a diff. Pick a **From** and a **To** version, or
  click **Diff** on a row to compare it with the previous version. Added lines are marked `+`
  and removed lines `-`.
