---
issue: 1230
section: Fixed
---

- A reader-layout BRD's Approved Requirements section reads the run the
  Requirements page opens on. After a re-run whose requirements are all still
  draft, it no longer lists the older run's approvals.
- Approving, un-approving, editing, restoring or promoting requirements makes
  such a BRD out of date. An auto-update BRD is regenerated, and sections that
  did not change are reused. A generation already running is not stopped by it.
  A change to only a requirement's version number or code links does not count.
- On upgrade, each auto-update reader BRD is regenerated once at its next
  check, because its input snapshot gains the approved requirements; its
  unchanged sections are reused.
