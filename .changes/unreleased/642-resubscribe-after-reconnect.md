---
issue: 642
section: Fixed
---

- Open views keep their live updates after the realtime connection drops and comes back (a network
  blip, the hourly session renewal, or a server-side disconnect). The Tasks and Scheduler pages,
  project documents, drift and job badges, connector progress, chat tool events, task progress,
  discussion threads, approvals, a watched publish batch and the "who's viewing" avatars now re-join
  their channels on reconnect instead of going silent until you navigate away and back.
