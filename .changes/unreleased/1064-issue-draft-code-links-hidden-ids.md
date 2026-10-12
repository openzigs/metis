---
issue: 1064
section: Fixed
---

- Issue drafts list the requirement's code links in a **Related code** section (up to 10): links
  when the publish target is the analysed repository on the same host, plain paths otherwise and
  always in a Jira issue. Bodies show no internal ids; a published issue carries them in a hidden
  `metis-source` comment. Issues published earlier are not rewritten.
- API: `POST …/drafts/generate` takes `targetBaseUrl`. Left out or `null` it is public GitHub, as on
  batch create; a value that is not an https URL gives plain paths, not an error.
- A METIS marker counts only on the last lines of an issue body; marker-shaped text elsewhere is
  shown as text. Adopting a tracker edit made below the marker no longer copies it into the draft.
- The dry-run plan lists issues, then sub-issue links, then labels, so titles are not cut off at 25
  rows. The epic draft is named after the batch; an existing epic draft keeps its title.
