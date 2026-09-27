---
issue: 236
section: Added
---

- A project's custom agent can be a chat's own agent: its persona, skills, tools,
  model and approval override apply as a library agent's do. One picker lists both.
- Analyses also run the library agents a project has explicitly enabled.
- Repository skill imports bring each skill's supporting files, within the folder
  limits; a path outside the imported folder is never read (#237).
- The built-in agents named tools that do not exist and so had none; they now name
  real ones, and an agent listing an unknown tool is refused on save (#238).
