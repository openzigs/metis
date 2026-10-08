---
issue: 863
section: Fixed
---

- Publishing: a published draft no longer stays selected, so later batches stop
  failing with `DRAFT_INELIGIBLE`. A finished batch can be archived from the list.
- Import drafts no longer repeat the upstream tag (`[Feature] [Feature]: …`), and
  pick up criteria listed under the issue's own "Acceptance criteria" heading.
- An import with more than 25 requirements asks which ones to draft, instead of
  drafting them all at once.
- Re-generating drafts for a project that already holds `[Feature] [Feature]: …`
  drafts creates new `[Feature] …` drafts alongside them, because the title is the
  dedup key. Review or discard the old drafts before publishing the new ones.
