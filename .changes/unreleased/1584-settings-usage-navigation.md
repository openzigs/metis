---
issue: 1584
section: Fixed
---

- The project switcher lists the active workspace's projects (and any project in no workspace)
  instead of every project you can open, and choosing a workspace re-lists it at once. On a
  project's pages the workspace crumb names that project's workspace, so a second user no longer
  sees their first workspace over a project in another one. A transient failure reading your
  workspaces is retried instead of showing no workspace for a minute.
- **Vault → Delete entry** asks for confirmation before it deletes, naming the reference that will
  stop resolving.
- **Activity → Runs**: the Chat turns table is no longer capped at the newest 50. **Load more chat
  turns** appends the next, older page (`GET /api/runs/chat-turns` returns a `nextCursor`, passed
  back as `?cursor=`).
- **Settings → Integrations → Teams** no longer logs a 404 to the browser console when Teams is
  not connected: `GET .../installation` answers 200 with `data: null`.
- Prompt-cache telemetry (`GET /api/admin/cache-telemetry`) tags model calls that set no call type
  by the run they belong to (`analysis`, `docs-gen` or `impact-analysis`) instead of counting them
  as `unknown`.
