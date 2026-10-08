---
issue: 731
section: Fixed
---

- A project created without a workspace can now be added to one. Project settings has a new
  **Workspace** card that lists the workspaces you own or administer; adding the project turns on
  requirement linking, workspace traceability and shared-database identities for it. The API is
  `PUT /api/projects/:id/workspace`. A project that is already in a workspace cannot be moved to
  another one, and only the project's creator or a system admin can move it. The move asks for confirmation. The "not part of a workspace" notices now link to this card.
