---
issue: 2293
section: Fixed
---

- An impact analysis started from pasted text no longer offers "Re-run, reading
  the document again". Such a run reads the pasted text, never the document, so
  the button did nothing it said.
- Saved document readings no longer pile up. Saving a reading deletes that
  document's readings of an earlier file or reader version, which could never
  be used again. Readings made with another model are kept, so switching the
  model back still reuses them.
- A document deleted while it was being read keeps no saved reading.
- A saved reading is never overwritten by a save made under another project.
