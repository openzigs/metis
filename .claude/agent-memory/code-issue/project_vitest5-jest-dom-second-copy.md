---
name: project_vitest5-jest-dom-second-copy
description: vitest 5 + pnpm: @testing-library/jest-dom/vitest loads a second vitest copy and breaks .rejects.toThrow; extend expect locally
metadata:
  type: project
---

In vitest 5 each `vitest` copy bundles its own `expect`. pnpm installs one `vitest` copy per `@types/node` peer (22/25/26 here), and `@testing-library/jest-dom/vitest` resolves a different copy than `ui` — so jest-dom matcher types vanish (TS2339) and every `.rejects.toThrow` breaks at runtime (PR #668). Fix used: `expect.extend(matchers)` from `@testing-library/jest-dom/matchers` in `ui/tests/setup.ts` plus `ui/tests/jest-dom-vitest.d.ts`. `@vitest/coverage-v8` must match `vitest` exactly — Dependabot bumped only `vitest`.

**Why:** v4 shared one `@vitest/expect`; v5 doesn't.

**How to apply:** never import `@testing-library/jest-dom/vitest` in a vitest-5 package; `packages/ui-kit` still does and works only by luck of resolution.
