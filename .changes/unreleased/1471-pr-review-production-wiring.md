---
issue: 1471
section: Fixed
---

- Automatic PR review now runs on a deployment. Each review uses the project's
  AI model and its GitHub repository connection's vault token (GitHub
  Enterprise included), and its spend counts toward the monthly limit. A project
  missing either is listed as not reviewed, with the reason, and no model call is made.
- Re-run review reads the pull request from GitHub first, so it no longer records
  a pull request that links an issue as linking none, and its SHA is the commit
  it reviewed. When a pull request is updated while a review of it is waiting,
  only the newest update is reviewed.
