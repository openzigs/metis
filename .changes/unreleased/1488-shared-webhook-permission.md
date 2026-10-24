---
issue: 1488
section: Security
---

- Shared-secret (`GITHUB_WEBHOOK_SECRET`) pull request deliveries go only to a connection whose token GitHub says has push or admin access to the repository, so a workspace connecting a public repository with no token (or a read-only one) can no longer take its reviews. The connection card explains why a connection gets none.
- A connection Test or scheduled refresh that hits a GitHub rate limit, a 5xx or a dropped connection no longer marks the connection *error*, so exhausting the server's GitHub quota cannot hand an incumbent's deliveries to another project. Only 401, 404 or a 403 refusing the token does.
- A connection Test or sync that overlaps a change to the connection records nothing, and a Test that marks a connection *error* forgets its recorded access.
- **Upgrade note:** existing connections take no shared-secret deliveries until they are tested again, because no earlier Test recorded which token it used. The server re-checks connected GitHub connections that have a token once after startup, in the background, one every 2 seconds; `REPO_PERMISSION_RECHECK=off` skips it. Applies migration `20261101001488_issue1488_repo_permission` (one nullable column).
