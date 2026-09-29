---
issue: 362
section: Fixed
---

- Generating GitHub issue drafts from an analysis whose requirements are still
  held by the approval gate no longer says "analysis has no requirements — run
  analysis first". The error names the pending and rejected approvals and the
  Publish page links straight to them on the Analysis page.
- "Generate GitHub Issues" on the Analysis page is disabled until the run has
  requirements, and says why: how many approvals must be resolved, with a link
  to them.
