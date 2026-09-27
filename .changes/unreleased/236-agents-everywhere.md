---
issue: 236
section: Added
---

- A project's custom agent can be a chat's own agent: its persona, skills, tools,
  model and approval override apply as a library agent's do. One picker lists both.
- Analyses also run the library agents a project has explicitly enabled.
- Skills import from a project's repository connector (`/api/skills/import/repository`)
  with their supporting files; a path outside the folder is never read (#237).
- The built-in agents named tools that do not exist and so had none; they now name
  real ones, and an agent listing an unknown tool is refused on save (#238).
- A chat can no longer be bound to a project the caller cannot access (#304).
