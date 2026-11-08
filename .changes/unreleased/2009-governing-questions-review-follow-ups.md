---
issue: 2009
section: Fixed
---

- A business analyst's answer to a governing-rule question is no longer lost
  when it could not be checked straight away, for example because the model's
  reply could not be read or the AI provider was unavailable. METIS checks it
  again the next time the questions are opened, without asking it again. These
  questions are no longer listed or exported under a different requirement's
  title, and they never name a policy control, even when it is written with
  different spacing or punctuation. Still behind the `GOVERNING_DOCS_ENABLED`
  setting, which is off by default.
