---
issue: 402
section: Fixed
---

- Upgrading past the issue-draft dedup cleanup no longer strands references to the duplicates it
  retired. A pending or running publish batch that listed a retired draft now lists the draft that
  was kept, so it publishes that draft instead of skipping it, and a new batch created from those
  ids no longer fails with "one or more drafts not found". Child drafts of a retired epic now
  point at the kept epic. Where two duplicates had both been published, the older one is kept
  and the other's GitHub issue is left for you to close.
