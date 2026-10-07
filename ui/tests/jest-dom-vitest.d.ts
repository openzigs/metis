/**
 * jest-dom matcher types for THIS package's copy of vitest (vitest 5, PR #668).
 *
 * `tests/setup.ts` still imports `@testing-library/jest-dom/vitest` for the runtime
 * `expect.extend`; only its *type* augmentation stopped reaching us. In vitest 5 each
 * `vitest` install declares its own `Assertion` (it no longer comes from one shared
 * `@vitest/expect`), and pnpm installs one `vitest` copy per `@types/node` peer. jest-dom
 * augments whichever copy it resolves from its own directory (the hoisted one), which
 * is not the copy `ui` resolves, so every jest-dom matcher read as missing (TS2339).
 *
 * Declaring the augmentation here makes `"vitest"` resolve from `ui/`, i.e. the copy the
 * tests import. It targets `Matchers<R, T>`, the v5 extension point `Assertion` extends.
 */
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Matchers<
    R extends void | Promise<void> = void | Promise<void>,
    _T = unknown,
  > extends TestingLibraryMatchers<unknown, R> {}
}
