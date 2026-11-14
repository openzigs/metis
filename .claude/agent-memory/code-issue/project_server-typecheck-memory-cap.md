---
name: server-typecheck-memory-cap
description: The server test typecheck (tsconfig.test.json) runs in chunks since #2503; an OOM (exit 2 naming a chunk) is capacity, not a code error.
metadata:
  type: project
---

History: one `tsconfig.test.json` program peaked at ~8.43 GB (#1308), 12.96 GB (#1873) and
passed the 14,336 MB cap on a 16 GB runner on 2026-11-14 (#2503).

- **Steady growth, not a hot type** (measured on #2503 with `--generateTrace`): Prisma
  types were 2.1M of 3.5M types in a 157-test sample; every `tests/*.sqlite.test.ts`
  costs ~170 ms and ~13 MB of its own Prisma instantiations. No file dominated.
- **Since #2503** `server`'s `typecheck` runs `scripts/typecheck-chunked.mjs`: every
  non-test root in each chunk, test files dealt round-robin, one chunk per 400 tests,
  8,192 MB heap each, run in sequence. Measured: 6 chunks, peak RSS 6.4 GB, 3.5 min.
- **If a chunk OOMs**, lower `--chunk-size` (more chunks), do not raise `--heap`. The
  script is pinned in `server/tests/typecheck-covers-tests.test.ts`.
- **Prove coverage** after changing the split: `node ../scripts/typecheck-chunked.mjs
  -p tsconfig.test.json --list-files` must equal `tsc -p tsconfig.test.json --listFilesOnly`.
- To check whether a change made typechecking heavier, compare `Types` and
  `Instantiations` from `tsc --extendedDiagnostics`, not `Memory used`.
