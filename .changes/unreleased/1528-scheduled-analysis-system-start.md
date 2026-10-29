---
issue: 1528
section: Fixed
---

- Scheduled analysis re-runs start again. They had failed at the first database write because the run recorded a user that does not exist; a run the scheduler starts is now recorded as started by the system.
