---
issue: 2193
section: Fixed
---

- Knowledge search finds more of a repository's code: each chunk of a source file is
  now embedded with its path in front (`File: internal/model/feed.go`), where before
  only a file's first chunk said which file it was. Keyword search and returned text
  are unchanged. On 30 Miniflux questions an expected file reached the top 5 for 20
  rather than 16, measured with `server/scripts/eval-repo-chunk-prefix.ts` (steps to
  reproduce in its header). **Existing projects need one Reindex** (Settings >
  Embeddings); nothing flags it, as `embeddings:migrate status` reads current.
