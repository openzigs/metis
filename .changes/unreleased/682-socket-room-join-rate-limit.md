---
issue: 682
section: Security
---

- Live-update room joins are now rate-limited per connection and per user. A client that
  repeatedly asks to follow discussions, jobs or other rooms it cannot see is refused once it
  exceeds the limit, before any access check runs, so it can no longer fill the audit log or load
  the database. Ordinary use, including re-following every room on a busy page after a reconnect,
  stays well under the limit, and a refused join shows no error toast. Operators can tune the limit
  with the `METIS_SOCKET_JOIN_*` settings in `.env.example`.
