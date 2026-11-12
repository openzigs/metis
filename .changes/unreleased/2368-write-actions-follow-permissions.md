---
issue: 2368
section: Fixed
---

- A role that cannot create projects, add connectors or delete projects is no longer offered the
  form only to be refused after submitting. New project (on Projects and Home) is shown only with
  `project.create`, the repository and database connector forms and a suggested connector's
  Configure and Dismiss only with `connector.write`, and a project's Delete only with
  `project.delete`. Without the permission, the page says to ask an admin. The server's checks are
  unchanged.
