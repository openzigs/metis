---
issue: 1579
section: Fixed
---

- **Settings → Embedding backends** no longer reads *Up to date* with a live **Reindex** button
  while a reindex is still running. The page keeps the checked project in its address, so a
  reload brings it back; it then shows **Reindex in progress**, disables the button and follows
  the running reindex's progress bar again. When the reindex runs on another server process, the
  page says so and checks again every few seconds until it ends.
- A repository's **Deep Ingest** progress now counts files during its longest step: the
  connector card reads *Ingesting source code (120 of 450 files)* instead of sitting on step
  3/5 with no figure, so a slow ingest can be told from a stuck one.
