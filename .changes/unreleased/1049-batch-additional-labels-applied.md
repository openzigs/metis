---
issue: 1049
section: Fixed
---

- A publish batch's **Additional labels** are now put on every issue the batch
  creates or updates, on GitHub and Jira, and the dry-run plan lists them.
  Before, they were only created in the repository. Internal labels are still
  dropped, and drift detection counts the batch's labels as published.
