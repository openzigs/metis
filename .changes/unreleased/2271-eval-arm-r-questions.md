---
issue: 2271
section: Changed
---

- The document-understanding eval's reader arm (`--arms R`) now asks the
  clarifying questions an analysis asks about a document the reader read, as
  the clarification dialog's first round, and scores them against the corpus's
  labelled ambiguities. A new Questions table gives each arm's questions asked,
  labelled ambiguities found, questions set aside and why, and those over the
  round's cap. A failed question round no longer fails the reading.
