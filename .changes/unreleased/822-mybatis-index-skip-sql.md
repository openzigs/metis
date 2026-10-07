---
issue: 822
section: Fixed
---

- A MyBatis mapper call site now always links to the real Java interface
  method. The lookup by method name could pick the synthetic SQL statement
  symbol that the MyBatis pass writes into the same Java file under the same
  name.
