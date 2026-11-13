---
issue: 2314
section: Security
---

- Document access restrictions now apply to code read outside chat's code tools. An analysis
  reads and searches only the repository files its requester may see: its code tools refuse a
  restricted file as if it were missing, and its code-symbol context leaves it out. A scheduled
  analysis sees no restricted file. Chat's and Spec Kit's code-symbol context is filtered the same
  way, and Spec Kit, whose documents the whole project reads, never sees a restricted file. A
  change to a user's role now reaches chat's code and knowledge search on their next call, not
  after the 30-minute result cache expired.
