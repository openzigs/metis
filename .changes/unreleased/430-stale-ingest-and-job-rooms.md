---
issue: 430
section: Fixed
---

- A project's Overview no longer shows "Ingesting…" until reload after the API restarts while a
  repository ingest started from the New-project wizard is in flight. If the server has no record
  of the job within 15 seconds of connecting, the Overview and the header's jobs indicator stop
  counting it as running.
- Leaving a page that follows a job no longer stops live updates for another part of the same page
  that follows that job.
