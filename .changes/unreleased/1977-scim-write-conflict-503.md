---
issue: 1977
section: Fixed
---

- A SCIM provisioning write that keeps colliding with concurrent changes is now answered
  `503 SCIM_WRITE_CONFLICT`, a status identity providers retry, instead of a server error
  (500). Nothing from the failed write is kept. `GOVERNING_DOCS_ENABLED` now reads its value
  through the same check every other boolean setting uses, so the two cannot drift apart.
