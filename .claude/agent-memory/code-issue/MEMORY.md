# METIS — code-issue Memory Index

Entries are capped at 150 bytes and the whole file at 17,500 (`pnpm agents:verify`).
Retire, do not delete: move a superseded pointer to `ARCHIVE.md`, which is never loaded.

- [Green api ≠ server runs](project_green-api-job-does-not-run-server-image.md) — RESOLVED #39: api smokes /healthz; SQLite only (#45)
- [Tag-ref caches are unreadable](project_tag-ref-gha-cache-is-write-only.md) — only that tag can restore it; check per-ref size
- [Budget rationale in 3 places](project_image-budget-rationale-lives-in-three-places.md) — docs + 2 comments; grep the tree when correcting one
