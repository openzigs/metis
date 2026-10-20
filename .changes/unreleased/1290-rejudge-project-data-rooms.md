---
issue: 1290
section: Security
---

- A member removed from a workspace stops receiving live analysis progress,
  chat-session tool events and approval prompts, connector and background-run
  progress, discussion messages and typing, and discussion and Spec Kit
  presence at once, not on reconnect, and drops off presence lists. The same
  applies to everyone but admins when a project or workspace is deleted.
- Those live updates can no longer be subscribed to on a deleted project.
- Deleting a usage override while a teammate replaces it no longer records the
  wrong author in the audit log.
