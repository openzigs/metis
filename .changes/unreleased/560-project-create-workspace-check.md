---
issue: 560
section: Security
---

- Creating a project now checks the workspace it is placed in. A non-admin can only create a
  project in a workspace they are a member of, and nobody can create one in a deleted workspace;
  either request is refused with "Workspace not found" and no project is created.
