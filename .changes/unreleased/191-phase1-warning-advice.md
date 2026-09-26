---
issue: 191
section: Fixed
---

- Each Phase-1 warning's summary now names a remedy that fits its cause:
  skipped formula extraction, unreadable SQL files and directories, an
  incomplete SQL scan and failed module fact extraction no longer point at
  unrelated settings. Long minified lines are split for formula extraction
  instead of skipped, so vendored bundles no longer degrade a document; a
  module directory that cannot be listed is reported, and Phase 1 keeps far
  less source in memory while counting chunks. A SQL scan that hit its
  directory bound is no longer told to fix read access, and a module whose
  fact extraction failed now marks the summary "Degraded output".
