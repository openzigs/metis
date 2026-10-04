---
issue: 856
section: Fixed
---

- Documentation generation checks its inputs between sections, not only at the final
  commit, so a document whose sources change mid-run stops at the next section instead
  of spending its whole budget first. The sections already written are kept as an
  unpublished draft.
