---
issue: 988
section: Fixed
---

- Publishing a Spec Kit feature's tasks to GitHub no longer fails with HTTP 422 when the feature
  has a long name. The `speckit:` and `story:` labels on each issue are now cut to GitHub's
  50-character limit and end in a short hash, so two long names still get different labels; the
  full feature name stays in the issue body. When GitHub does refuse an issue as invalid, the
  error now names the field it rejected (for example, a label name) instead of pointing at the
  vault token.
