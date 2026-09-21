/**
 * Issue #876 — datasource setup for the DEFAULT (`pnpm test`) unit suite only.
 *
 * The generated Prisma client is a single global artifact whose provider is baked in at
 * `prisma generate` time, while `src/lib/prisma.ts` picks its driver adapter from
 * `DATABASE_URL` at module-load time. When the two disagree, every module that transitively
 * imports `prisma.ts` throws at import — 219 of 952 test files, measured on `main`. That is
 * what forced a `prisma generate` toggle before every `pnpm test` while dogfooding METIS on a
 * Postgres dev database.
 *
 * This file removes the toggle: it points `DATABASE_URL` at the provider the generated client
 * was actually built for, at module scope, before any source module is imported. Nothing
 * connects — see `lib/db/generated-client-provider.ts` for why the unit suite needs no
 * database at all, and why the synthesized Postgres URL is deliberately unconnectable.
 *
 * Loaded from `vitest.config.ts` and deliberately NOT from `vitest.integration.config.ts`:
 * `pnpm test:integration` talks to a real database and must see the operator's real
 * `DATABASE_URL` — or fail loudly against it — never a rewritten one.
 *
 * Scope note: this aligns the *adapter*. It does not pin which branch provider-conditional
 * application code takes (`resolveReindexLeaseBackend()`, `resolveDatabaseProvider()`,
 * `detectLineageSqlEngine()`), which read `DATABASE_URL` lazily per call. A unit test that
 * cares must pin the datasource itself — the pattern `knowledge-service.reindex.test.ts`
 * already uses — rather than inherit whatever the developer's shell happens to hold.
 */
import {
  alignedDatabaseUrl,
  readGeneratedClientProvider,
} from "./lib/db/generated-client-provider.js";

const aligned = alignedDatabaseUrl(readGeneratedClientProvider(), process.env.DATABASE_URL);
if (aligned !== null) {
  process.env.DATABASE_URL = aligned;
}
