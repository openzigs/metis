---
issue: 50
section: Fixed
---

- A documentation generation interrupted by a server restart no longer stays
  "generating" forever. Running generations now heartbeat, and within about
  five minutes of a restart the document is marked failed with an "interrupted"
  explanation and a one-click **Regenerate** that reruns it in place
  (`POST /projects/:id/docs/:docId/regenerate`), reusing modules already analysed.
