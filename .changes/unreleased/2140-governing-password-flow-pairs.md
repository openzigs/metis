---
issue: 2140
section: Changed
---

- `eval:governing`: the real-text tuning set `governing-04-openemr-asvs` gains eight OpenEMR
  issues that set or change a password or add a way of signing in, labelled blind, and the
  per-rule consistency pass the held-out `governing-03` had. A judge change tuned on them was
  read once on `governing-03` and not shipped: recall rose from 0.75 to 0.83, but precision fell
  from 0.76 to 0.65 and one gap was reported as **Compliant**. Governing checks are unchanged
  and stay marked **Preview**.
