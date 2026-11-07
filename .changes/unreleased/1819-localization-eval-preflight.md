---
issue: 1819
section: Fixed
---

- The localization eval now fails before spending anything when a `--reference` arm is
  not one of the run's arms, or when an A3N run's repository clone is missing; before,
  both failed only after earlier arms had been paid for. Reference tables now print the
  same item-coverage lines as the A0 tables, and the pooled report keeps a reference's
  section when no other arm ran beside it. The documented in-sample tuning command now
  names the run-7 corpus, so a weight sweep no longer reads the held-out sets as well.
