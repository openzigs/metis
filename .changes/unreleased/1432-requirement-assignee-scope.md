---
issue: 1432
section: Security
---

- A requirement can be assigned only to an active user who can open its project: a member of the project's workspace or a system admin, the people the assignee picker offers. Anyone else, an unknown id included, gets the same 404 and nothing is saved. Before, any user id was accepted, and the reply showed that user's name.
- Existing assignments to someone who can no longer open the project are still listed, without their name. The SLA reminder no longer goes to them, or to a project creator who has left.
