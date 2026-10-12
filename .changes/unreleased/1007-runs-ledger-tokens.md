---
issue: 1007
section: Fixed
---

- A run's tokens now read the usage ledger everywhere they are shown (the analysis run list and
  header, `/runs` and a run's page) as two named figures, with and without cache. They used to
  disagree (215.4k in the list, 479.8k in the header). A run that is going shows its total so
  far, or "in progress", instead of "0 tok".
- `/runs` lists chat turns in their own table, read from the usage ledger, with each turn's
  tokens and exact cost. A chat turn is not a run and never appeared there.
