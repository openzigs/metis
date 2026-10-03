---
issue: 717
section: Fixed
---

- Knowledge search finds the code that defines something, not only its tests:
  keyword search now splits identifiers into words (`PollingScheduler` matches
  "polling scheduler"), folds plurals and tenses, and matches file paths.
- Results show the score they are ordered by; a keyword-only result is marked
  "keyword match" instead of printing `0.000`.
- Repository files are named by their real path (`internal/model/feed.go`, not
  `src/internal/...`) in document lists, search, chat and Deep Dive drafts.
