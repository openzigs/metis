---
issue: 1429
section: Security
---

- Forgetting a project memory (Chronicle) entry now deletes it only when it belongs to the project
  in the request. An entry from another project, including one in a workspace you cannot reach,
  answers the same "not found" as an entry that does not exist, and is left untouched.
