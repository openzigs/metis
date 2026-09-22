---
issue: 14
section: Fixed
---

- Approving or editing a requirement, commenting, replying, editing a comment
  and assigning a requirement no longer fail with HTTP 500: the UI was
  JSON-encoding those request bodies twice. `apiFetch` now throws outside
  production when handed an already-serialised string body.
