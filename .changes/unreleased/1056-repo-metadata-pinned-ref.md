---
issue: 1056
section: Fixed
---

- A repository connector pinned to a tag or branch reads its README, manifests
  (`go.mod` and the rest) and top-level tree at that ref's commit, not the
  default branch, so it no longer ingests a newer release's dependency versions.
  Skills import reads at the pinned ref too. The OVERVIEW document names the ref
  and commit and labels languages repo-wide. **Re-ingest pinned connectors** to
  replace their stored metadata documents.
