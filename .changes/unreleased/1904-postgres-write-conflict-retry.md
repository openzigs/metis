---
issue: 1904
section: Fixed
---

- On a Postgres deployment, a single sign-in that first links an existing account no longer fails
  with a server error when another sign-in links a different account at the same moment: the
  database's refusal is now retried, as it already was when two sign-ins contested one account.
