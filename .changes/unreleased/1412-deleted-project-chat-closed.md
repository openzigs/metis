---
issue: 1412
section: Security
---

- A chat in a deleted project is closed to everyone but administrators: it leaves the session
  lists, and opening, reading, continuing, forking, compacting or approving in it answers the same
  "not found" as a chat that never existed. A link to such a chat now says "Chat not found".
  Administrators keep their own chats in it. Live task and publish-batch progress now follows the
  task's or batch's project access too, instead of the role alone (#1297).
