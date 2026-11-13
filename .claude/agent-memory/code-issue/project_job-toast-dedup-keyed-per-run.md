---
name: job-toast-dedup-keyed-per-run
description: A job toast's de-dup state must be keyed per run, because a generated document keeps its id across regenerations (#2418).
metadata:
  type: project
---

`ui/src/lib/terminal-toast.ts` de-duplicated by `jobId`. A generated document keeps its id across regenerations, so the second run's completion toast was swallowed as a duplicate.

**How to apply:** key de-dup state by the run (its own identity), never by the artefact id; test two consecutive runs for the same artefact.
