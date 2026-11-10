---
issue: 2149
section: Changed
---

- `eval:governing`: a change to the applicability judge was tuned and not shipped. It brought in
  the common-password check on flows that set a password, and the second-factor rule on new
  ways of signing in. Read once on the held-out `governing-03` together with #2152's change,
  recall rose from 0.75 to 0.81, but a password-change request drew extra rules again and,
  four times over the three runs, a gap or an open pair was reported as **Compliant**. Governing checks are unchanged and stay marked
  **Preview**.
