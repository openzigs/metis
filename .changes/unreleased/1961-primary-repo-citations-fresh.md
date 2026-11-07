---
issue: 1961
section: Fixed
---

- In a project with several repositories, a code citation the analysis makes into another
  repository than the one its code pass ran for (typically the primary repository, cited from a
  secondary repository's pass) is now saved as checked, with that repository's commit, instead
  of "unverified" until the repository is next re-ingested.
