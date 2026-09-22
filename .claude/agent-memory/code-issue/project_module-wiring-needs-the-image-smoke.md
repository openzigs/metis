---
name: module-wiring-needs-the-image-smoke
description: Top-level module wiring (a constructed client class, factory registration order, import-time resolution) is invisible to unit tests; only lint or the image smoke catch it
metadata:
  type: project
---

**Durable finding (review of #55, persisted by #60):** reverting the line that
constructs the resolved Prisma client class (`new PrismaClientForProvider` →
`new PrismaClient`, `server/src/lib/prisma.ts`) fails NO unit test; only ESLint's
unused-variable rule and the image smoke (`scripts/lib/smoke-server-image.mjs`)
catch it. Top-level module wiring needs the smoke (or lint), not unit tests.

**Confirmed twice more by #60.** Running the smoke's Postgres arm with production's
backends (`VECTOR_STORE=pgvector`, `DISCUSSION_RATE_LIMIT_BACKEND=postgres`, …) found
that production's values could not boot: three rate limiters resolved their store at
IMPORT, before `createServer()` registered the Postgres factory, and the pgvector
factory was registered after `createApp()` built routers that resolve it. The whole
unit suite was green: it runs under `NODE_ENV=test`, where the registration block is
skipped, so no test ever exercised the real order.

**How to apply:** when a change touches module-scope state, a factory seam
(`__set*Factory` / `register*()`), or which env selects a backend, prove it on a
real boot — run the smoke arm whose env selects that backend
(`node scripts/lib/smoke-server-image.mjs --image <tag> --arm postgres`), or add the
backend's env to `POSTGRES_ARM_BACKENDS`. A unit test that sets the factory itself
cannot see an ordering bug.
