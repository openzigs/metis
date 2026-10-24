---
issue: 1471
section: Fixed
---

- Automatic PR review now runs on a deployment, with the project's AI model and
  its GitHub (or Enterprise) connection's vault token. Spend counts toward the
  monthly limit; with a limit set, a model that has no price is not reviewed.
- Re-run review reads the pull request first and reviews the commit it read.
- GitHub publishing and PR review now connect to the checked Enterprise address,
  use the egress proxy, refuse redirects and time out after 20 seconds.
