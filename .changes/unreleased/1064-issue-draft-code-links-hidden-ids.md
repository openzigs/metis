---
issue: 1064
section: Fixed
---

- Issue drafts list the requirement's code links in a **Related code** section (up to 10, the rest
  counted): links when the publish target is the analysed repository, plain paths with no owner,
  name or commit otherwise. Feature and epic bodies show no internal ids; a published issue carries
  them in a hidden `metis-source` comment. Issues published earlier are not rewritten.
- A METIS marker counts only on the last lines of an issue body. Marker-shaped text elsewhere is
  shown as text, not stripped, so the published issue is the previewed draft plus the marker.
- The dry-run plan lists issues, then sub-issue links, then labels, so titles are not cut off at 25
  rows. The epic draft is named after the batch; an existing epic draft keeps its title.
