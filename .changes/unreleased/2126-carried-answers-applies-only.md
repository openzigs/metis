---
issue: 2126
section: Fixed
---

- An answer to a company-policy question that is carried to another requirement can now only show
  that a rule applies there, never that it does not. A finding is no longer removed by an answer
  given about a different requirement. When the answer would rule the rule out, that requirement
  asks its own question.
- Submitting answers no longer waits for METIS to check them against every other requirement of
  the analysis. That check runs after the submit, a few requirements at a time, and the next round
  of questions waits for it. A retry with the same answers does not check them again.
