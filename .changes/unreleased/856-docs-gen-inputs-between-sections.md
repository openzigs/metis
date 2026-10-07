---
issue: 856
section: Fixed
---

- Documentation generation checks its inputs between sections, not only at the final
  commit, so a document whose sources change mid-run stops at the next section instead
  of spending its whole budget first. It is marked failed; the sections already written
  are kept for the regenerate to reuse.
