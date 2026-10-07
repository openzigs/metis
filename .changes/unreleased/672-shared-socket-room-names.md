---
issue: 672
section: Changed
---

- Live-update room subscriptions now take their room names from one shared
  definition used by both the server and the UI. A page that stops following a
  discussion thread, chat session, task, analysis, publish batch or presence
  room can no longer drop the room for another view that still follows it
  because the two disagreed on its name. No behaviour change.
