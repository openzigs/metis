---
issue: 962
section: Fixed
---

- A Spec Kit issue export that stopped part-way no longer blocks the feature forever. An
  abandoned or ambiguous claim is looked up on GitHub before the task is re-created, and
  adopted if the issue exists, so a retry does not file a duplicate. Only issues the
  token's own user filed since the task was first claimed are adopted.
- The dry run shows claimed tasks as in progress or "abandoned, will reconcile", and the
  Spec Kit panel offers **Clear stuck export**.
