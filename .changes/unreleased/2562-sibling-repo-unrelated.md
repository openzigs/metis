---
issue: 2562
section: Fixed
---

- Portfolio gap analysis now confirms a gap when the repository a requirement
  belongs to shows it is missing, instead of reading "could not verify" because
  another repository in the product does something else entirely. A repository
  that was never checked (no excerpts found, a failed search, the budget spent,
  or a failed model call) still stops a product from reading "does not cover
  it". On the fixture-repo eval, gap accuracy rose from 0.17 to 0.56.
