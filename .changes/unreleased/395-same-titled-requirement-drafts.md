---
issue: 395
section: Fixed
---

- Generating issue drafts gives every requirement its own draft, even when one
  analysis holds two requirements with the same title. Before, the second one
  overwrote the first one's draft body, so one requirement was left with no
  draft and the other's draft showed the wrong text. Re-running the analysis
  refreshes the same drafts instead of creating new ones.
