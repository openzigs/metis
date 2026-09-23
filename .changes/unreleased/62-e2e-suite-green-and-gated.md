---
issue: 62
section: Fixed
---

- The Playwright suite runs on every pull request again, and passes. The `e2e`
  job was gated behind an `E2E_ENABLED` repo variable nobody had set, so nothing
  ran it and ~150 of 591 specs had failed on `main`.
- Realtime works in the e2e stack and in the app: the browser reaches the API's
  socket server, and a job's last lifecycle event is replayed to a late
  subscriber instead of leaving its surface on "Running…".
- Defects the revived suite surfaced: a signed-out visitor can read a workspace
  invitation link, the assignee picker finds people, deleted comments stay in
  their thread, a version conflict stops flagging an unchanged `labels` array,
  and an unknown approval request answers 404 instead of 500.
- The pending-drift badge's three parked e2e specs are live again, and the
  live-update one now drives a real signed webhook so it proves the count moves
  without a reload rather than that the badge is still on screen.
- A late subscriber's replayed job state is scoped to projects it can access, and
  a version conflict no longer depends on the key order of a JSON field.
