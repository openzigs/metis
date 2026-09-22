---
issue: 17
section: Fixed
---

- The code graph no longer attributes calls by name alone. `arr.join()`,
  `.trim()`, `vi.mock()` and `beforeEach()` were bound to whichever project
  symbol shared the name, so the Code Overview ranked them above `AppError` and
  `apiFetch`. Member calls now need evidence about their receiver, runtime and
  test-framework names never bind by name, and test files are left out of the
  overview's top-symbol table.
