---
issue: 45
section: Fixed
---

- The `metis-server` image starts against Postgres. Its only Prisma client was
  built for SQLite; it now has one client per database.
- The image runs from `/app/server`, and its default data directory
  (`/app/server/data`, for LanceDB and uploads) is writable by the server's user.
  To keep that data, mount a volume at `/app/server/data` (#54).
- CI boots the image on both SQLite and Postgres.
