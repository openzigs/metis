---
issue: 1567
section: Fixed
---

- A clarification answer keeps its `<` and `>`. An answer like `published_at < X` was saved into
  the requirement as `published_at X`, which dropped the comparison. Answers now keep `<`, `<=`,
  `>` and `&` exactly as typed, and text shaped like a tag (`<tag>`) shows as text on the
  Requirements hub, in reviews, in exports and in published issues.
