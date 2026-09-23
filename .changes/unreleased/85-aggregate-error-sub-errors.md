---
issue: 85
section: Fixed
---

- A logged `AggregateError` now records its sub-errors. `errors` is an own but
  non-enumerable property, so it was dropped by both the explicit key list and
  the object spread the log redactor rebuilds errors from — every `Promise.any`
  and batched-connector rejection logged only the aggregate's own "All promises
  were rejected", with nothing about why each attempt failed.
