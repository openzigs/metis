---
issue: 1170
section: Fixed
---

- A requirements-scoped BRD no longer shows `metis:clarifications` markers as text, in the page or
  in the Markdown, PDF and Word exports. Each requirement's Clarifications heading now sits under
  that requirement in the Contents, and the introduction names the analysis run by its start time
  and a review by its title instead of an internal id. Regenerate an existing BRD to pick this up.
