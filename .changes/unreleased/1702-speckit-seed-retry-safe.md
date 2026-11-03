---
issue: 1702
section: Fixed
---

- **Start Spec Kit feature** is safe to retry: after a lost response, pressing
  it again with the same ticks opens the feature already made instead of a
  second one. It no longer moves you if you left the page mid-run.
- A filter change on the requirements list unticks what it hides, so a hidden
  requirement is never sent.
- Requirement text in a feature's `spec.md` stays fenced as untrusted data in
  later Spec Kit commands, and a selection too large for one `spec.md` is
  refused before the model call.
