---
issue: 2248
section: Security
---

- A discussion or Teams `@AI` reply is read by everyone in the thread or channel, so it is now
  grounded only on documents with no access restrictions. Before, it was grounded on what the
  person who asked could see, and an excerpt restricted to them could reach everyone else.
- A deactivated or deleted user, including an administrator, can no longer retrieve restricted
  documents with a session that has not yet expired.
- The document access editor no longer offers `group` entries: METIS does not know who is in a
  group, so such an entry matched no one. An existing group entry is shown with a warning so it
  can be removed.
