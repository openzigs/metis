---
issue: 1432
section: Security
---

- A requirement can be assigned only to an active user who can open its project: a member of the project's workspace or a system admin, the people the assignee picker offers. Anyone else, an unknown id included, gets the same 404 and nothing is saved. Before, any user id was accepted, and the reply showed that user's name.
- Existing assignments are still listed, but without the name of an assignee or assigner who can no longer open the project. The SLA reminder no longer goes to such a person, and a reminder whose recipient check fails is retried on the next run instead of being dropped.
