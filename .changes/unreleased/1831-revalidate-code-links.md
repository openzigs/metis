---
issue: 1831
section: Added
---

- When METIS re-reads a repository, it now re-checks every saved code link into that repository,
  without calling a model. A link to code that moved (to other lines or another file) is updated to
  the new location, and the old location is remembered. A link to code that was deleted or edited
  is marked out of date with the reason, and is never deleted. Links you added by hand are only
  marked, never changed.
