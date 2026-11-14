---
issue: 2448
section: Security
---

- An analysis you start now reads code with your own access: its file tools and code searches
  read the restricted files you can see (the code graph still leaves them out). Anyone who can't see one of those files sees the findings that drew
  on it, and the requirements built from the run, as "Restricted"; you and anyone with the same
  access see everything. The change request and the Spec Kit handoff say how many restricted
  files the analysis read, never which. Scheduled analyses, and document reading and search,
  still use only what everyone on the project can see.
  The live capability event no longer carries the titles of findings cut at the cap, on any run.
