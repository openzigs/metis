/**
 * Issue #876 — make the unit suite run against EITHER generated Prisma client.
 *
 * ## The coupling this removes
 *
 * The generated Prisma client is a single global artifact and its provider is baked in at
 * `prisma generate` time (`prisma.config.ts` picks the schema by `DATABASE_URL` scheme).
 * `src/lib/prisma.ts` picks the *driver adapter* from `DATABASE_URL` at MODULE-LOAD time.
 * When the two disagree, every module that transitively imports `prisma.ts` throws at import:
 *
 *   The Driver Adapter `@prisma/adapter-better-sqlite3`, based on `sqlite`, is not
 *   compatible with the provider `postgres` specified in the Prisma schema.
 *
 * Measured on `main`: a Postgres-generated client + the suite's default (SQLite) datasource
 * fails 219 of 952 test files that way. That is why dogfooding METIS on a Postgres dev DB
 * required a `prisma generate` toggle before every `pnpm test`.
 *
 * ## What the fix can and cannot be
 *
 * It CANNOT be "run the unit tests against a real Postgres". The unit suite does not execute
 * SQL at all: it stubs Prisma per-suite with `vi.mock("../src/lib/prisma.js", …)`, and a full
 * run on a clean checkout leaves `server/dev.db` at **0 bytes** — the file handle is opened,
 * no statement is ever run. Provisioning a database for it would add startup cost and a
 * dependency on Docker while exercising nothing. Real-Postgres parity is the job of
 * `pnpm test:integration` and the `postgres-adapter` CI job, which is where it stays.
 *
 * So the fix is to make the suite's datasource follow the client that is actually generated:
 * read the provider off the generated artifact and hand `prisma.ts` a matching URL, so the
 * adapter it builds is always compatible. Nothing connects through it.
 *
 * ## Why the generated `schema.prisma` is the source of truth
 *
 * Prisma 7 exposes no `activeProvider` on the public `Prisma` export (checked on 7.8.0 —
 * `Prisma` carries `prismaVersion` and the scalar-field enums, and `Prisma.dmmf` has only
 * `datamodel`, no datasource block). What it DOES emit is a verbatim copy of the schema it
 * generated from, next to the client output. We resolve that copy the same way the client
 * package itself reaches its output — `require(".prisma/client/default")` — so the answer is
 * always the artifact the running process will actually load, whatever the package layout.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** The two providers this repo generates a client for. */
export type GeneratedClientProvider = "postgresql" | "sqlite";

/**
 * Datasource URL the unit suite runs on when the generated client is SQLite. Identical to
 * `DEFAULT_SQLITE_URL` in `src/lib/prisma.ts`, i.e. exactly what an unset `DATABASE_URL`
 * already resolved to — the SQLite path stays bit-for-bit unchanged.
 */
export const UNIT_TEST_SQLITE_URL = "file:./dev.db";

/**
 * Datasource URL the unit suite runs on when the generated client is Postgres and the
 * environment offers no Postgres URL of its own.
 *
 * Deliberately unconnectable: port 1 has no listener, so the failure mode of a unit test that
 * unexpectedly reaches for a real database is an immediate ECONNREFUSED naming this URL —
 * not a hang, and never a write into somebody's dev database. Only ever used to CONSTRUCT
 * `PrismaPg`, which opens no connection. Carries no credentials, both because it needs none
 * and so it can never be mistaken for a real one by a secret scanner.
 */
export const UNIT_TEST_POSTGRES_PLACEHOLDER_URL =
  "postgresql://127.0.0.1:1/metis_unit_test_never_connected";

/**
 * Classify a `DATABASE_URL` the way `src/lib/prisma.ts` and `prisma.config.ts` do.
 * Returns `null` for an absent or unrecognized scheme rather than guessing.
 */
export function providerForDatabaseUrl(
  databaseUrl: string | undefined,
): GeneratedClientProvider | null {
  const url = (databaseUrl ?? "").trim();
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    return "postgresql";
  }
  if (url.startsWith("file:") || url.startsWith("sqlite:")) {
    return "sqlite";
  }
  return null;
}

/**
 * Pull the datasource provider out of a `schema.prisma` source.
 *
 * Only the `datasource` block's provider counts — the file also carries a `generator` block
 * whose provider is always `prisma-client-js`, and doc comments that mention the word
 * "provider" for unrelated reasons (AI providers, sandbox providers). Returns `null` when the
 * file declares a provider this repo does not generate for.
 */
export function parseDatasourceProvider(
  schemaSource: string,
): GeneratedClientProvider | "unknown" | null {
  const block = /datasource\s+\w+\s*\{([^}]*)\}/.exec(schemaSource);
  if (!block) {
    return null;
  }
  const provider = /provider\s*=\s*"([^"]*)"/.exec(block[1]);
  if (!provider) {
    return null;
  }
  if (provider[1] === "postgresql" || provider[1] === "postgres") {
    return "postgresql";
  }
  if (provider[1] === "sqlite") {
    return "sqlite";
  }
  return "unknown";
}

/**
 * Absolute path of the `schema.prisma` copy Prisma emits beside the generated client, or
 * `null` if it cannot be resolved (client not generated yet, or a layout we do not know).
 */
export function generatedClientSchemaPath(): string | null {
  try {
    const fromHere = createRequire(import.meta.url);
    // `@prisma/client/index.js` is a stub that re-exports `.prisma/client/default`; resolving
    // from the stub's own directory reproduces exactly the lookup it performs at runtime.
    const clientStub = fromHere.resolve("@prisma/client");
    const generatedEntry = createRequire(clientStub).resolve(".prisma/client/default");
    return path.join(path.dirname(generatedEntry), "schema.prisma");
  } catch {
    return null;
  }
}

let cached: GeneratedClientProvider | "unknown" | null | undefined;

/**
 * Provider baked into the currently-generated Prisma client, or `null` when it cannot be
 * determined. Memoized — `setupFiles` re-run for every test file, and a forked worker runs
 * many of them.
 */
export function readGeneratedClientProvider(): GeneratedClientProvider | "unknown" | null {
  if (cached !== undefined) {
    return cached;
  }
  const schemaPath = generatedClientSchemaPath();
  if (!schemaPath) {
    cached = null;
    return cached;
  }
  try {
    cached = parseDatasourceProvider(readFileSync(schemaPath, "utf8"));
  } catch {
    cached = null;
  }
  return cached;
}

/** Test seam — drop the memoized provider so a suite can re-read it. */
export function __resetGeneratedClientProviderCache(): void {
  cached = undefined;
}

/**
 * Provider a `DATABASE_URL` resolves to *the way `src/lib/prisma.ts` resolves it*, i.e. with
 * its documented "unset means SQLite" default applied. `null` still means an unrecognized
 * scheme, which `prisma.ts` treats as a fatal misconfiguration.
 */
function effectiveProvider(databaseUrl: string | undefined): GeneratedClientProvider | null {
  if ((databaseUrl ?? "").trim() === "") {
    return "sqlite";
  }
  return providerForDatabaseUrl(databaseUrl);
}

/**
 * The `DATABASE_URL` the unit suite must expose while source modules are being imported, so
 * the adapter `prisma.ts` builds matches the generated client.
 *
 * Returns `null` to mean "leave the environment alone" — which is the answer in three cases,
 * each deliberately a no-op rather than a guess:
 *   - the generated provider could not be determined, or is one this repo does not generate
 *     for. Prisma's own "adapter X is not compatible with provider Y" message is far more
 *     useful than a silently rewritten datasource;
 *   - the datasource already resolves to the generated provider. Notably this covers the
 *     default SQLite run, where `DATABASE_URL` is unset and stays unset, so that path is
 *     unchanged down to the variable being absent — and it covers a developer who pointed
 *     the suite at a specific database, who keeps it;
 *   - the scheme is unrecognized. `prisma.ts` fails loudly on those by design; rewriting it
 *     would hide a genuinely broken configuration.
 */
export function alignedDatabaseUrl(
  generatedProvider: GeneratedClientProvider | "unknown" | null,
  currentDatabaseUrl: string | undefined,
): string | null {
  if (generatedProvider !== "postgresql" && generatedProvider !== "sqlite") {
    return null;
  }
  const current = effectiveProvider(currentDatabaseUrl);
  if (current === null || current === generatedProvider) {
    return null;
  }
  return generatedProvider === "postgresql"
    ? UNIT_TEST_POSTGRES_PLACEHOLDER_URL
    : UNIT_TEST_SQLITE_URL;
}
