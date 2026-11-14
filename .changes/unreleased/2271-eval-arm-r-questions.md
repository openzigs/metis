---
issue: 2271
section: Changed
---

- The document-understanding eval's reader arm (`--arms R`) now asks the
  clarifying questions an analysis asks about a document the reader read:
  the requirements are extracted from the reader's statements, the questions
  are written and selected as the clarification dialog's first round, and they
  are scored against the corpus's labelled ambiguities. The report has a new
  Questions table: for each arm, the questions asked, the labelled ambiguities
  found, the questions set aside and why, and the questions left over the
  round's cap.
