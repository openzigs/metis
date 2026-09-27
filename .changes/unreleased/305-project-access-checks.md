---
issue: 305
section: Security
---

- MCP project allow-lists, project server lists and project-scoped server installs, the review
  queue and review actions, the run history, and custom-agent enablement now check that you can
  reach the project. A project in another workspace answers "not found".
- A chat in a project you have lost access to stays closed on every route, including model
  switches, plans, background messages, skills and the resumable-session list.
- A chat can use only a vault provider key you may read (the vault's `vault.read` permission:
  administrators, coordinators and developers; not readers), checked when the chat is created
  and on every turn.
