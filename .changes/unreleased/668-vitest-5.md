---
issue: 668
section: Changed
---

- Test runner moves to vitest 5.0.2, with `@vitest/coverage-v8` bumped in lockstep (it pins
  `vitest` to its exact version). The UI suite now extends its own `expect` with the jest-dom
  matchers, because the `@testing-library/jest-dom/vitest` entry loaded a second vitest copy
  under vitest 5 and broke `.rejects.toThrow`.
