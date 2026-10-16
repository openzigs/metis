---
issue: 1170
section: Fixed
---

- A requirements-scoped BRD no longer shows `metis:clarifications` markers as text, in the page or
  in the Markdown, PDF and Word exports. Headings inside a requirement's text, Clarifications
  included, are nested under that requirement and no longer appear in the Contents as top-level
  sections, and the introduction names the analysis run by its start time
  and a review by its title instead of an internal id. Regenerate an existing BRD to pick this up.
