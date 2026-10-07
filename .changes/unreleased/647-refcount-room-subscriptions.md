---
issue: 647
section: Fixed
---

- Closing one view of a discussion thread, chat session, task, analysis, publish batch or presence
  list no longer stops live updates in another open view of the same item on the page; the socket
  now leaves the room only when its last follower does.
