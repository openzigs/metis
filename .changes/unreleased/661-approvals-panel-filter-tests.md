---
issue: 661
section: Changed
---

- The approvals panel's live "promotion blocked" banner is now pinned by tests:
  an event for another analysis neither shows its banner nor refetches, and a
  replaced callback is the one that runs. No behaviour change.
