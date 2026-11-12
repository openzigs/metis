---
issue: 2261
section: Security
---

- A deactivated or deleted user whose session has not yet expired now gets a "sign in again"
  response from document retrieval and cross-project search, instead of a server error.
- A document's access list can no longer be given a new `group` entry: METIS does not know who
  is in a group, so the entry would match no one. A group entry a document already has can stay
  while the rest of its access list is edited.
