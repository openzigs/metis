---
issue: 490
section: Fixed
---

- Re-running an analysis that holds two requirements with the same title no
  longer swaps their issue drafts when the new run lists them in a different
  order. Each draft is matched back to the requirement whose text it was
  generated from. An approved or published draft whose requirement text changed
  on the re-run keeps its existing body rather than taking new text, so a
  published GitHub issue is never edited with its sibling's description.
