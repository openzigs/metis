---
issue: 2546
section: Security
---

- A document restricted to some project members no longer reaches the others. They can't start a
  portfolio check or an impact analysis from it, and the ones a permitted member started show them
  the verdicts and scores but none of the document's text. The analyses list no longer sends a
  run's raw metadata. A discussion about a requirement drawn from the document names it
  "Restricted", as everywhere else.
- Those members see the document in the Documents list as "Restricted", without its name, and with
  a note that they don't have access. It can't be ticked for an analysis or offered as an impact
  source, and it isn't counted among the documents a run reads. A change request started from it
  doesn't name it to them: its source reads "Restricted", and a title Metis made from the
  document's name is made again without it, in the list, on the result page, on reviews and in
  chat.
