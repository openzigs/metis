---
issue: 1488
section: Security
---

- Shared-secret (`GITHUB_WEBHOOK_SECRET`) pull request deliveries go only to a connection whose token GitHub says has push or admin access to the repository, so a workspace connecting a public repository with no token (or a read-only one) can no longer take its reviews. The connection card explains why a connection gets none.
- A connection Test or scheduled refresh that hits a GitHub rate limit, a 5xx or a dropped connection no longer marks the connection *error*, so exhausting the server's GitHub quota cannot hand an incumbent's deliveries to another project. Only 401, 404 or a 403 refusing the token does.
- **Upgrade note:** existing connections take no shared-secret deliveries until they are tested again (click **Test**, or wait for a scheduled refresh): no earlier Test recorded which token it used. Applies migration `20261101001488_issue1488_repo_permission` (one nullable column).
