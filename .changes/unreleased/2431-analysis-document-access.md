---
issue: 2431
section: Security
---

- An analysis and a Spec Kit artifact no longer draw on documents some project members cannot
  read. Their results are shared with the whole project, so every document search they run (the
  code agent's, the document and other specialists' retrieval, the requirement-by-requirement
  search, the fallback to unapproved uploads, and the documents used when none are selected) now
  leaves out any upload or repository file with an access restriction, even when the person who
  started the run could read it. Spec Kit's list of callers and its change localisation no longer
  name a restricted file, and an analysis's list of code affected by new requirements no longer
  names one either. The change request says how many passages were left out, for example "2
  matching passages from restricted documents were left out: results are shared with the whole
  project, so they include only what everyone on it can see." Only the count is shown and stored.
