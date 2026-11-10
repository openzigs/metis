---
issue: 2149
section: Fixed
---

- Governing checks: a request that adds or changes a step where a password is chosen, or a new
  way of signing in, now draws the rules whose own words name that step (a check of every new
  password against common passwords; what every sign-in must use). It no longer drops them for
  saying nothing of their matter, and it does not draw the password length and composition
  rules with them. Governing checks stay marked **Preview**.
