---
issue: 527
section: Security
---

- A logical import now places every upload connector's archive path under the
  importing server's archive directory (`UPLOAD_ARCHIVE_DIR`), whatever the
  bundle or a `--remap` spec says. Previously an imported row could name a file
  anywhere on disk, and deleting that connector would remove it. The path is
  rewritten before the row is saved, so an import that fails part-way never
  leaves the bundle's path behind; a `--remap` that sets `uploadPath` is ignored
  with a warning. Copy each `<id>.zip` from the source server's archive
  directory to the target's.
- Deleting an upload connector now logs a warning when its extracted working
  copy cannot be removed, instead of failing silently.
