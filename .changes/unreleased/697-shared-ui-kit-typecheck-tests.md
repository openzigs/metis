---
issue: 697
section: Fixed
---

- `pnpm typecheck` now type-checks the tests of `@metis/shared` and `@metis/ui-kit` (`tests/**` and co-located `src/**/*.test.ts`) through a `noEmit` `tsconfig.test.json` in each package; previously both tsconfigs excluded them, so a type error in a test could reach `main` unnoticed. The five errors this surfaced in `@metis/shared`'s tests are fixed. `build` output is unchanged.
