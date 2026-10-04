---
issue: 844
section: Changed
---

- CI runs the Playwright e2e suite in three parallel shards, so a pull request
  waits for about a third of the suite instead of all of it. Every spec still runs
  on every PR; `e2e-outcome` is the single check that reports the result.
- On pull requests, the Postgres unit-suite rerun (`postgres-adapter`) runs only when
  a database-layer path changes, and the `api` job builds and smoke-tests the
  container images only when an image-relevant path changes. Both always run on
  pushes to `main`, on a new nightly run, and (for the server image) on Dependabot
  PRs. A `changes` job's summary says what ran and why.
