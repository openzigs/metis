---
issue: 1870
section: Added
---

- When a governing document (a company policy) is uploaded, METIS now pulls
  out its individual rules: each one has a one-line summary, the policy's own
  control id (or a generated `R-001`…), and the exact clause it comes from.
  A rule is kept only if its quoted clause appears word for word in the
  uploaded text, so no rule cites wording the policy does not contain. Every
  workspace member can read the rules as soon as extraction finishes, and a
  workspace admin can edit a rule's summary or control id, or remove it; each
  change records who made it and when. If extraction fails, the document shows
  why and the upload itself is kept. Still behind the `GOVERNING_DOCS_ENABLED`
  setting, which is off by default.
