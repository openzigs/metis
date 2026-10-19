---
issue: 1156
section: Fixed
---

- A re-run that is stopped while its "continue" check is still running no longer leaves the next
  re-run unable to call the model, and a database error while a re-run or repository resume is
  finishing no longer leaves the analysis marked as running until the server restarts.
