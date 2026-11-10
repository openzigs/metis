---
issue: 2152
section: Changed
---

- `eval:governing`: a change to the findings call was tuned and not shipped. It stopped one
  provided part of a multi-part rule from earning **Compliant** on the rest on both tuning sets.
  Read once on the held-out `governing-03`, it reported a safeguard that can be switched off as
  **Compliant** in every run. Governing checks are unchanged and stay marked **Preview**.
