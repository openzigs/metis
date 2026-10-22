---
issue: 1223
section: Fixed
---

- The reader BRD's main-part code-name check now catches names that start or
  end in an acronym (`MinifluxSessionID`, `XMLHttpRequest`, `HTTPServer`,
  `parseURL`) and names inside underscore bold or italics. A live run had
  reported zero while Key Business Rules named a session cookie constant.
  Acronyms, all-caps words and two-word brand names stay unflagged.
