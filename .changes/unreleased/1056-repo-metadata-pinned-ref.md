---
issue: 1056
section: Fixed
---

- A repository connector pinned to a tag or branch reads its README, manifests
  and top-level tree at that ref's commit, not the default branch; skills import
  does too. **Re-ingest pinned connectors.** A ref missing upstream (an untested
  connector's implicit `main` on a `master` repo) still reads the default branch.
- OVERVIEW names the ref and commit and labels languages repo-wide; `Default
  branch:` is now `Upstream default branch:` and `HEAD sha:` is now `Commit:`.
