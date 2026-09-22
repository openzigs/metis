---
issue: 57
section: Fixed
---

- A test-coverage run checks its budget before each suggestion cluster, as it already did between
  judge batches. The suggestion phase used to check once, before it started, and then make every
  cluster's model call whatever the budget. It now stops part-way once the budget is reached, and
  after the first call served by a model with no price.
