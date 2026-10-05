---
issue: 848
section: Added
---

- A failing nightly CI run now opens a `ci-nightly` tracking issue with the run link
  and the failing jobs (or comments on the one already open), and a later green
  nightly comments on and closes it. Before, only the person who last edited the
  schedule was notified. Pull requests show the new `nightly-report` check as
  skipped.
