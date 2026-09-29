---
issue: 369
section: Fixed
---

- Two analyses with a requirement of the same title now get separate issue drafts. Before, the
  second analysis overwrote the first one's draft, kept its approved or published status, and on
  publish edited the first analysis's GitHub issue in place. The second draft is now titled with a
  ` (2)` suffix, as epic drafts already were, and re-running an analysis still refreshes its own
  drafts. The database now also refuses a second live draft with the same dedup key, so two
  generations running at the same time cannot both claim one title; any duplicates left from
  before are soft-deleted by the migration, keeping the published draft (or else the oldest).
- Exporting test-coverage suggestions to GitHub again now reuses each suggestion's existing draft
  instead of inserting a second one, so an export that the approval gate refused can be retried
  once the review is approved.
