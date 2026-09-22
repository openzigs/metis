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
