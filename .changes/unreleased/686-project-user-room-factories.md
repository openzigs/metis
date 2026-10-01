---
issue: 686
section: Changed
---

- Project-wide live updates (document, drift, connector, job, usage and
  background-run events) and personal notifications (mentions, reviews, SLA
  deadlines) are now sent to rooms named by the same shared definition the
  subscribing side uses, so the two can no longer drift apart. Room names are
  unchanged. The lint rule that rejects hand-written room names in server code
  now covers project and user rooms too.
