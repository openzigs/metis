---
name: server-typecheck-memory-cap
description: The server test typecheck (tsconfig.test.json) runs near its Node heap cap; an OOM (exit 134) there is capacity, not a code error (#1308).
metadata:
  type: project
---

Measured on PR #1308 (2026-10-16): `server` `tsconfig.test.json` typecheck peaked at about 8.43 GB on `main`, past the old 8,192 MB `--max-old-space-size`. It failed with exit 134 (V8 out of memory) on a change that added no type errors.

- An OOM there is **capacity**, not a type error. Do not hunt for a type bug.
- To check whether a change made typechecking heavier, compare the `Types` and `Instantiations` counts from `tsc --extendedDiagnostics`, not `Memory used`, which varies from run to run.
- The cap is now **12,288 MB**, pinned in `server/tests/typecheck-covers-tests.test.ts`. Raise it there when needed, not only in the script.
