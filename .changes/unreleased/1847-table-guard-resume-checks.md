---
issue: 1847
section: Fixed
---

- The localization eval's `IMPACT_AGENT_SEEDS` table-precision check (arm A7) can no
  longer pass by mistake when it is resumed. It now refuses to continue if the eval
  database no longer holds the requirements an earlier analysis saved, or if the test
  corpus or the pinned repository has changed. A resumed run also no longer pays again for
  the baseline reading, and the check prints its comparison intervals itself.
