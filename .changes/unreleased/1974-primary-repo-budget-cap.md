---
issue: 1974
section: Fixed
---

- On a project with more repositories than the code pass's token budget fits, the repositories
  skipped are now always the newest non-primary ones. Before, the skipped one depended on the
  order the database returned them in, so the primary repository could get no code pass of its
  own. A regenerate of the code pass picks its repositories the same way.
