---
issue: 99
section: Fixed
---

- The `scripts` test suite no longer fails with a timeout when its files run in parallel. The one
  test that must scan the whole tree for private terms now reads the result of a single scan done
  before the tests start, and it still fails when a term is present.
