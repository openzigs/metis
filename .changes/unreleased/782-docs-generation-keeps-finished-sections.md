---
issue: 782
section: Fixed
---

- A documentation generation that fails late no longer throws away what it finished. Each section
  is saved as soon as it is written. If the run then fails, a first-time document is kept as
  **degraded**, with the finished sections and a warning saying where it stopped, and a
  **Regenerate** button finishes it. A document that already has a published version keeps that
  version and is marked failed.
- A failed or partial document now says why it stopped: which stage (fact extraction, writing
  sections, assembling, saving), which section was in progress, and the error's class. Before, it
  said only "the details are in the server log", which most users cannot see.
- Regenerate resumes instead of starting over. It reuses every finished section whose inputs have
  not changed, together with the module facts already cached, so it is not billed again for that
  work.
