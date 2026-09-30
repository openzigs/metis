---
issue: 428
section: Fixed
---

- Creating a project with a source repository no longer says only "Project created" when the
  repository could not be linked. The project is still created, and a warning now says why the
  link failed (for example, an API base URL that is not HTTPS) with a button to open the
  project's Connections page. `POST /api/projects` reports the reason in a new
  `primaryRepoError` field, which is `null` when the link succeeded or none was requested.
