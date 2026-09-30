---
issue: 390
section: Fixed
---

- Workbench: switching project or agent while the first message is opening a
  session cancels that request, so the composer is ready again at once.
- Workbench: a first message refused before any answer (for example, a 4xx) no
  longer adds the empty session to Recent.
- Workbench: a reply cancelled by a project or agent switch no longer shows an
  "aborted" error banner.
