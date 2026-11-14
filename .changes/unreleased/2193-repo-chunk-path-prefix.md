---
issue: 2193
section: Fixed
---

- Knowledge search finds more of a repository's code. Each chunk of a source file
  is now indexed with the file's path in front of it (`File: internal/model/feed.go`),
  where before only a file's first chunk said which file it was. On the Miniflux
  walkthrough project, "how often are feeds refreshed" now shows the chunk holding
  `ScheduleNextCheck` in the default top 5 (it was 6th), and across 30 Miniflux
  requirement questions an expected file reached the top 5 for 18 rather than 13.
  What a search returns is unchanged. Existing projects pick this up on their next
  **Reindex** (Settings > Embeddings); new and changed files get it when ingested.
