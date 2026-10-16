---
issue: 1212
section: Fixed
---

- Every member of a project's workspace now gets the project's live updates
  (analysis and document progress, connector, usage and drift events), not only
  the analyst who created the project. Before, teammates saw a job finish only
  after reloading the page.
- Anyone who loses access stops receiving those updates straight away: a
  member removed from a workspace, everyone in a deleted workspace, everyone
  but admins on a deleted project, and non-members of a workspace an older
  project is moved into.
- Live usage updates no longer include the id of the chat session that made the
  call.
