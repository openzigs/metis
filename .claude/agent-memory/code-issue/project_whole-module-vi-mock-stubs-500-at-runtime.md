# A whole-module `vi.mock` stub 500s the route the day it needs a second export

**Found:** #67 (2026-09-22), `server/tests/unit/generated-docs-route.test.ts`.

The docs-route suite stubbed `grounding/degraded-warnings.js` with a factory
exporting **only** `deriveDocStatus`:

```ts
vi.mock("../../src/lib/docs-gen/grounding/degraded-warnings.js", () => ({
  deriveDocStatus: vi.fn(/* … */),
}));
```

`vi.mock` with a factory replaces the WHOLE module, so every other export is
absent. Nothing failed while the route happened to use only that one symbol.
The moment the route reached `sectionFailedWarning` (via the #67 read-path
sanitiser) the request threw

```
[vitest] No "sectionFailedWarning" export is defined on the
"…/degraded-warnings.js" mock. Did you forget to return it from "vi.mock"?
```

and the express error handler turned it into a **500 with a green-looking test
name** — the failure read as "my new route code is broken", not "the fake
diverged from the module it stands in for". It cost a debug cycle because the
500 body is only visible if you print it.

**Rule.** Stub a module wholesale only when you mean to replace all of it. To
spy on one export of an otherwise-real module, use a PARTIAL mock:

```ts
vi.mock("…/degraded-warnings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("…/degraded-warnings.js")>()),
  deriveDocStatus: vi.fn(/* … */),
}));
```

`degraded-warnings.ts` is a pure module with zero imports, so there was never a
reason to fake the rest of it. Check the module's import graph before reaching
for a whole-module factory: if it pulls in nothing heavy, `importOriginal` is
strictly better and cannot rot.

**Where to look first** when a supertest case returns an unexplained 500:
`console.log(res.status, JSON.stringify(res.body))` — vitest's mock errors
arrive as ordinary thrown errors and are swallowed by the app's error handler.

## A Prisma double must honour `select` (PR #1315)

A `findUnique` mock that returns a full fixture whatever `select` asks for hides a
column the real query forgot to select: the code reads it from the fixture and
the test passes. Make the double apply `select` — the `selecting()` helper in
`server/tests/comments-live-997.test.ts` does. Same family as the publishing
doubles that ignored `where` ([[publishing-safety-is-tested-on-the-stamped-body]]).

## Other vitest mock traps, folded here (retired from the index 2026-10-21; files unchanged)

- [[vi-mock-const-misses-default-param]] — mocking an exported constant does not
  reach a default parameter inside the same module; pass it explicitly (#509).
- [[vitest-beforeeach-return-is-cleanup]] — `beforeEach(() => m.mockReset())`
  returns the mock, which vitest runs as cleanup; use a block body (#685).

**Folded here (retired from the index 2026-10-21; files unchanged):**

- [[publishing-safety-is-tested-on-the-stamped-body]] — Test the STAMPED body: strip split a code span; double honours status

## A module-level default holding an imported function (PR #1354)

`const defaultDeps = { restore: restoreCloneAtCommit }` reads the export at import time,
so every test that `vi.mock`s `repo-service.js` without that export fails to import the
module. Wrap it as `(...args) => restoreCloneAtCommit(...args)`, resolved at call time
(`server/src/lib/connectors/repo/clone-health.ts`); see [[repo-clone-preflight-and-health]].

## Concurrent dynamic imports of a mocked module (#1408, ui vitest)

- In ui vitest, a second concurrent dynamic `import()` of a `vi.mock`ed module from the same
  importer can resolve to the REAL module. A concurrency test must assert identity
  (`toBe(first)`), not only the mock's call count.
- So mock call counts cannot prove a single-flight fix, and overlap guards go untested,
  unless the `import()` sits behind an injectable loader seam (#1408 review;
  `ui/src/lib/socket-client.ts` has one, `SocketIoModule`).
