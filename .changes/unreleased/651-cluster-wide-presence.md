---
issue: 651
section: Fixed
---

- On a multi-replica deployment, the "who is viewing" avatars on an artifact or
  a discussion thread now show everyone viewing it, whichever replica each
  person is connected to. They used to show only the people on the viewer's
  own replica. Someone who disconnects drops off every viewer's list, and the
  people on a replica that stops responding drop off within about 11 seconds.
  Thread avatars still list only people allowed to read the thread.
