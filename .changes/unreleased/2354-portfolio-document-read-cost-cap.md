---
issue: 2354
section: Fixed
---

- A portfolio check started from a document now counts the cost of reading the document against
  the run's cost cap (`PORTFOLIO_GAP_RUN_COST_CAP_CENTS`). Before, the reading's cost was added to
  the check's total but never checked against the cap, so a large document could take a run past
  it. If the reading uses the whole cap, the repositories are listed as not checked because the
  budget ran out.
- A portfolio check of many requirements searches up to four groups of requirements at once
  instead of one after another, while the whole check keeps to one bound (16 project searches at
  once) across all its products. No group is searched once the budget is spent or the check is
  cancelled.
- The user guide's impact tiers now say that **Possible** applies only downstream, that
  **Needs review** also covers a check that stored no readable path, and that a product you chose
  to build the requirement is **Must change**.
