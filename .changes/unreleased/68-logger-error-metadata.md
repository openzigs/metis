---
issue: 68
section: Fixed
---

- `log.error("…", { err })` writes the error's `name`, `message` and `stack`
  rather than `{}`. `redact()` rebuilt every metadata object from
  `Object.entries(...)`, and an `Error`'s message and stack are not own
  enumerable properties, so every call site under `server/src` that logged an
  error recorded no detail at all.
