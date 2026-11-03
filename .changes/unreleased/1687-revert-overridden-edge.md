---
issue: 1687
section: Added
---

- An integration edge whose strength you overrode can now be returned to what
  detection found. On the product page, an edge marked "Detected (overridden)"
  has a **Revert to detected** button; after you confirm, the edge gets
  detection's own kind, strength and direction back. METIS now keeps
  detection's classification when you override an edge, and each detection
  run that finds the edge again keeps it current. An edge overridden before
  this release has no saved classification, so it shows as unclassified until
  detection next runs. Reverts are recorded in the audit log.
