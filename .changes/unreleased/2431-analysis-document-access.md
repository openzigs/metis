---
issue: 2431
section: Security
---

- An analysis and a Spec Kit artifact no longer draw on documents some project members cannot
  read. Their results are shared with the whole project, so every document search they run (code
  agent, specialists, requirement-by-requirement search, the fallback to unapproved uploads, the
  documents used when none are selected) and the whole-document reader, when turned on, leave out
  any upload or repository file with an access restriction, even one the person who started the
  run could read. Spec Kit's callers and change localisation, and an analysis's affected-code
  list, no longer name a restricted file. The change request says how many passages were left
  out ("2 matching passages from restricted documents were left out: results are shared with the
  whole project, ..."); only the count is stored, and the audit log names who started the run.
