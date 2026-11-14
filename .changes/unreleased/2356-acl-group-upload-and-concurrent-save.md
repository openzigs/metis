---
issue: 2356
section: Security
---

- Two people saving a document's access list at the same time can no longer bring back a group
  entry that one of them has just removed. A save is checked against the list it replaces. When
  the list keeps changing during the save, the editor now says so and asks you to reload, and it
  now shows why any save was refused. Publishing a generated document also refuses a group entry
  the document did not already have, as the access editor does.
