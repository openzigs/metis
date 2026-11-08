---
issue: 1865
section: Fixed
---

- The semantic answer cache (off by default) reads the project's content version before it retrieves
  context, and does not store an answer when the content version at the end of the turn differs
  from the one at its start. Content that changes and changes back during a turn is not detected.
  It now tries an exact repeat before embedding the question.
