---
issue: 382
section: Fixed
---

- Starting or answering a clarification dialog no longer fails with a server error when a
  requirement has no list of ambiguities (older saved requirements, or model output that left the
  field out). Such a requirement is treated as having no open questions.
