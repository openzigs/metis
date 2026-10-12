---
issue: 1064
section: Fixed
---

- Issue drafts list the requirement's code links in a **Related code** section (up to 10, the rest
  counted), and no longer print project, analysis and requirement ids in the footer: a published
  issue carries them in a hidden `metis-source` comment, which is still readable in its source.
- The dry-run plan lists issue actions before label upserts, so titles are not cut off at 25 rows,
  and its "not shown" line says what was left out. The epic draft is named after the batch rather
  than its first requirement; an existing epic draft keeps its title.
