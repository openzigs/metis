---
issue: 1063
section: Fixed
---

- The Affected code panel no longer links code that only shares two words with a
  requirement but is about something else. "Last successful refresh in feed API"
  no longer links the web session's refresh throttle, the API-key `last_used_at`
  column or a test; "Mark all as read older than X" no longer links the
  mark-read-on-view setting. Test code is never shown as a link. The code agent's
  starting points are unchanged.
