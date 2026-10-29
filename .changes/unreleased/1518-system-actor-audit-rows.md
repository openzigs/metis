---
issue: 1518
section: Fixed
---

- System-initiated actions keep their audit row. The boot repository permission re-check,
  the scheduled connector refresh, the publish reconcile, the replaced-secret sweep and
  library auto-discover recorded their actor as `system`, which is not a user, so the
  audit insert failed its foreign key ("Audit write failed … Foreign key constraint
  violated") and the row was lost. They are now written with no actor and
  `actorType: "system"` in the row's metadata, the shape pull request review audits
  already use.
