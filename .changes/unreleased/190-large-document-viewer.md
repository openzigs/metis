---
issue: 190
section: Fixed
---

- Large generated documents open quickly. A 611,592-character document's view
  now downloads 0.63 MB instead of 27 MB: a version's body, provenance and
  changed symbols load only when you open them.
- The viewer renders a long document section by section, as you scroll or jump
  to a heading. Find-in-page still finds text in sections not yet rendered.
- Links to repeated headings, such as a second "Edge Cases", go to the right
  place: every heading has its own id.
