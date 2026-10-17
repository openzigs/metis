---
issue: 1230
section: Fixed
---

- A reader-layout BRD's Approved Requirements section reads the run the
  Requirements page opens on. After a re-run whose requirements are all still
  draft, it no longer lists the older run's approvals.
- Approving, un-approving or editing a requirement makes such a BRD out of
  date. An auto-update BRD is regenerated, and sections that did not change
  are reused. A write that changes only a requirement's version number no
  longer counts as a change.
