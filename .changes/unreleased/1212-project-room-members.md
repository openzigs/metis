---
issue: 1212
section: Fixed
---

- Every member of a project's workspace now gets the project's live updates
  (analysis and document progress, connector, usage and drift events), not only
  the analyst who created the project. Before, teammates saw a job finish only
  after reloading the page.
- A member removed from a workspace, or everyone in a deleted workspace, stops
  receiving those updates straight away.
- Live usage updates no longer include the id of the chat session that made the
  call.
