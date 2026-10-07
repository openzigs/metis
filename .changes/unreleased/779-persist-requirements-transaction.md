---
issue: 779
section: Fixed
---

- Re-running requirement synthesis can no longer delete review work that lands
  while it runs, or leave the analysis describing a set it never wrote. The
  reviewed-work check, the analysis markers, the delete and every insert now
  run in one transaction (on Postgres the set is locked before it is checked),
  so a failed insert keeps the previous set and its markers, and a comment or
  link added mid-replace is refused rather than silently cascaded away.
- More human work now protects a reviewed requirement set from replacement:
  stakeholder links, manual spec and code mappings, recorded implementations,
  issue drafts, discussion threads, and soft-deleted requirements.
