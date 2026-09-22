---
name: tag-ref-gha-cache-is-write-only
description: GitHub Actions caches written from a tag ref are restorable only by that same tag, so cache-to in a tag-only workflow wastes the 10 GB limit
metadata:
  type: project
---

GitHub Actions caches written from a tag ref can be restored only by that same
tag. So `cache-to` in a tag-only workflow (`build-images.yml`) spends the 10 GB
repository cache limit for nothing, and LRU eviction then removes `main`'s
entries, which are the ones every PR reads. Reading still works: a tag run can
restore `main`'s cache, so keep `cache-from`.

**Why:** Review of PR #38 (advisory A4); `build-images.yml`'s tag-push
`cache-to` was removed in that PR. The same review measured one PR writing
3.09 GB in 98 entries after two runs of `type=gha,mode=max`.

**How to apply:** Whenever a PR adds `type=gha,mode=max`, check the per-ref
footprint with `gh api repos/<owner>/<repo>/actions/caches` and confirm that the
ref writing the cache is one a later run can read.
