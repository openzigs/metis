---
issue: 473
section: Fixed
---

- A job's live status and the per-section progress of a document generation keep updating after
  the connection drops and comes back, including the reconnect that follows every sign-in token
  refresh. Before, the page stopped receiving that job's events until it was reloaded.
