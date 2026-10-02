---
issue: 733
section: Fixed
---

- Publishing no longer defaults to the analysed repository (an open-source
  project's upstream). A saved per-project GitHub publish target pre-fills every
  publish form and survives a reload; with none saved, the fields start empty.
- The publish batch form takes the selected drafts' target as its value.
- "Deep Dive → Issue" shows and lets you change the target repository, and
  refuses a GitHub publish with no target rather than filing upstream.
- A warning appears when a target is the repository the project analyses.
