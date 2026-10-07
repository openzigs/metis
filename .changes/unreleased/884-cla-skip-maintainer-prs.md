---
issue: 884
section: Changed
---

- The CLA check no longer runs on pull requests opened by the maintainer.
  Commits that Claude Code writes for the maintainer are authored by an address
  linked to no GitHub account, so the check failed on every one of them. The
  check still runs on every pull request anyone else opens.
