---
issue: 698
section: Changed
---

- Server tests under `tests/lib`, `tests/library`, `tests/unit`, `tests/integration`,
  `tests/helpers`, `tests/routes` and `tests/connectors` now type-check cleanly (batch A of the
  test type-check work); the dead vitest-4 `poolOptions` block is gone from `server/vitest.config.ts`.
