---
name: fake-api-filters-must-match-github-semantics
description: A fake GitHub API in scripts/*.test.mjs that applies a filter differently from the real API can make the guard behind it untestable; check each fake's filter semantics against GitHub's docs. Also: check every clause of an owner's correction comment, not just its headline.
metadata:
  type: project
---

In `scripts/*.test.mjs`, a fake GitHub API that applies a filter differently from the real API
can make the guard behind it impossible to test. On #1147 (PR #1148) the fake applied
`IssueFilters.since` to `closedAt`, but GitHub applies it to `updatedAt`. So an issue closed long
ago and edited recently never reached the script in tests, and the `inReadWindow` guard that drops
it could be replaced with `if (true)` and stay green (code-review on PR #1148). Check each fake's
filter semantics against the GitHub docs.

Two more ways the same fake lied, found in the same fix cycle:

- It returned its own objects by reference, so the script saw the fake's in-place update of a
  field's options without re-reading GitHub's response. Removing the re-read stayed green until
  `ok()` returned `structuredClone({ data })`, as JSON off the wire would be.
- `updateProjectV2Field` replaces the whole option list. An option sent back without its `id` is a
  new option, and every item that held the old one is emptied. A fake that keeps options by name
  hides that. Model the id rule, then test that dropping `id` empties an item.

A process finding from the cycle-2 re-review of the same PR:

- When the issue owner posts a correction comment that changes an earlier spec, check every
  clause of it against the PR, not just the clause it headlines. On #1147 the correction was
  headlined "Area becomes a managed field", and the fix cycle did that. The same comment also
  said "Tier inheritance from the parent epic also stays as merged", and that clause was missed
  until the re-review blocked on it.
