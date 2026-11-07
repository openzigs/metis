---
issue: 1917
section: Fixed
---

- Knowledge searches on the default LanceDB store that are narrowed to some documents or to
  the active embedding model now return up to the number of matches asked for. The filter used
  to run after the nearest rows were picked, so chunks from excluded documents (a superseded
  revision, a deleted document) or from an older model took those places and the search came
  back with fewer hits, or none. The filter now runs first. On a large indexed table, a
  very narrow filter can still come back short when its matches sit outside the partitions a
  search checks (#1922).
