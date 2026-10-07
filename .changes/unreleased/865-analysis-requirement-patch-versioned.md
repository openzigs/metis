---
issue: 865
section: Fixed
---

- `PATCH /api/analyses/:id/requirements/:reqId` is now a versioned write: an edit bumps the
  requirement's version and records history, so a baseline compare shows it. A stale body
  `version` gets the same 409 conflict as `PUT /api/requirements/:id`.
