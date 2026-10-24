---
issue: 1475
section: Security
---

- A project in another workspace can no longer take over a repository's GitHub pull request deliveries by connecting the same repository. A GitHub repository connection can have its own webhook secret and receiver URL (**Create webhook secret** in Connections), and deliveries to it go to that project only.
- Shared-secret (`GITHUB_WEBHOOK_SECRET`) deliveries go to the project whose connection was set to the repository earliest, among connections whose Test succeeded; while that connection stays connected, a later project can neither take them nor stop them.
- **Upgrade note:** a repository connection that was never tested (still *pending*) gets no shared-secret reviews until you click **Test**. Rotating `VAULT_MASTER_KEY` invalidates every connection's own webhook secret: those cards say "needs a new secret" (OPERATIONS.md §4). Applies migration `20261030001475_issue1475_repo_webhook_secret` (three nullable columns, one index).
