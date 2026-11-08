---
issue: 2018
section: Fixed
---

- "Analyze remaining repositories" no longer fails, and loses the completed pass, when a repository
  has many code findings to save or the database is briefly busy. The write that replaces the
  repository's earlier findings now has up to a minute to finish, instead of five seconds.
