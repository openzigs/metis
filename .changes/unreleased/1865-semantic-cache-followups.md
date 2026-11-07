---
issue: 1865
section: Fixed
---

- The semantic answer cache (off by default) reads the project's content version before it retrieves
  context, so an answer retrieved from content that changed during the turn is never stored. It now
  tries an exact repeat before embedding the question.
