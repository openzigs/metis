---
issue: 2356
section: Security
---

- Two people saving a document's access list at the same time can no longer bring back a group
  entry that one of them has just removed. A save is checked against the list it replaces. When
  the list keeps changing during the save, the editor now says so and asks you to reload, and it
  now shows why any save was refused. Indexing a document also refuses a group entry the document
  did not already have, as the access editor does.
  If someone removes a group entry while the document is being indexed, indexing now stops with
  a message asking you to index it again, instead of retrying.
