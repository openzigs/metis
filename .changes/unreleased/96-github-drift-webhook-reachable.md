---
issue: 96
section: Fixed
---

- Editing, closing, relabelling or reassigning a published issue on GitHub now
  records drift. Before this fix the spec-kit `tasks.md` sync and the drift
  reconciler both registered `POST /api/webhooks/github/issues`, and only the
  first one was ever reached. GitHub edits never showed up on the sync dashboard
  or the pending-drift badge, but every delivery still returned `200`. That
  single webhook URL now runs both pipelines. The response reports the drift
  result under `drift`, and the spec-kit fields stay where they were. You don't
  need to reconfigure the webhook.
