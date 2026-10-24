---
issue: 1475
section: Security
---

- A project in another workspace can no longer take over a repository's GitHub pull request deliveries by connecting the same repository. A GitHub repository connection can now have its own webhook secret (**Create webhook secret** in Connections), and deliveries signed with it go to that project only.
- **Upgrade note:** a repository that one project connects keeps working with `GITHUB_WEBHOOK_SECRET`. If several projects connect the same repository with that shared secret, automatic reviews for it stop (logged as `pr_review.webhook_owner_ambiguous`) until each connection has its own secret. Applies migration `20261030001475_issue1475_repo_webhook_secret` (one nullable column).
