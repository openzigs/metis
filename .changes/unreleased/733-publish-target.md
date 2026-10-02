---
issue: 733
section: Fixed
---

- Publishing no longer defaults to the analysed repository (an open-source project's upstream).
  A saved per-project GitHub target pre-fills every publish form; with none, fields start empty.
- The publish batch form takes the selected drafts' target, or stays empty when they disagree.
- "Deep Dive → Issue" and the Scans-page finding publish file into the chosen or saved target
  and refuse (`ERR_NO_PUBLISH_TARGET`) rather than file into the analysed or scanned repo.
- A warning appears when a target is the repository the project analyses.
- GitHub owners may contain underscores (Enterprise Managed User `handle_shortcode`).
