---
issue: 1873
section: Added
---

- When METIS cannot tell whether one of the workspace's governing rules applies
  to a requirement, it now asks you a plain business question in the
  clarifying questions, such as "Will the saved card keep the customer's whole
  card number?". It never asks you about the rulebook itself. One question
  covers every rule the same fact settles. Your answer then decides whether
  those rules apply. METIS first tries to answer the question from your
  project's own documents, never from the policy. Still behind the
  `GOVERNING_DOCS_ENABLED` setting, which is off by default; with it off, the
  clarifying questions are exactly as before.
