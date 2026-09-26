---
issue: 182
section: Fixed
---

- Repository sync now indexes the whole repository for grounding and chat, not
  the first 200 files alphabetically (`REPO_SOURCE_MAX_FILES`, default 5,000),
  production code first and tests last. On onyourleft, 860 of 860 files are
  indexed, 361 of them under `packages/`; before, 200 and none.
- Files over 64 KB are chunked and indexed instead of silently skipped.
- Each sync records its progress and result, a re-run resumes an interrupted
  one, and documents grounded on an incomplete index are marked for review.
- After upgrading, documents generated before a repository's next sync read as
  degraded ("coverage never recorded"); re-sync each repository once to clear it.
