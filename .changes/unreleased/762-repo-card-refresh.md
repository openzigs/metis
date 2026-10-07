---
issue: 762
section: Fixed
---

- A repository connector card now shows `connected` and the commit as soon as
  the automatic first ingest finishes, instead of staying `pending` until a page
  reload.
- **Test** on a repository connector no longer leaves a stuck progress row
  reading `repo.get /`. Count-less progress (a metadata fetch, a schema read)
  shows a readable label and clears on its own.
