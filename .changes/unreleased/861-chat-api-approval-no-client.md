---
issue: 861
section: Fixed
---

- `POST /api/ai/chat` no longer waits two minutes on a tool approval no client can answer. With no
  chat open for the session, the call is refused at once, the AI answers without it, and the
  response lists it under `toolApprovals`. Send `awaitToolApproval: true` to wait for an answer
  given through the approvals endpoint.
