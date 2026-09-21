/**
 * Issue #876 — tests for the harness that lets `pnpm test` run against either generated
 * Prisma client.
 *
 * The load-bearing property is NOT "it returns a string". It is that the harness only ever
 * rewrites `DATABASE_URL` when it KNOWS the rewrite is required, and otherwise leaves the
 * environment exactly as it found it — because a wrong rewrite would swap Prisma's precise
 * "adapter X is not compatible with provider Y" error for a silent, mystifying one, and
 * would let the harness quietly redirect a datasource a developer chose on purpose.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  UNIT_TEST_POSTGRES_PLACEHOLDER_URL,
  UNIT_TEST_SQLITE_URL,
  __resetGeneratedClientProviderCache,
  alignedDatabaseUrl,
  generatedClientSchemaPath,
  parseDatasourceProvider,
  providerForDatabaseUrl,
  readGeneratedClientProvider,
} from "./generated-client-provider.js";

describe("providerForDatabaseUrl", () => {
  it("classifies both Postgres spellings", () => {
    expect(providerForDatabaseUrl("postgres://u:p@h:5432/db")).toBe("postgresql");
    expect(providerForDatabaseUrl("postgresql://u:p@h:5432/db")).toBe("postgresql");
  });

  it("classifies both SQLite spellings", () => {
    expect(providerForDatabaseUrl("file:./dev.db")).toBe("sqlite");
    expect(providerForDatabaseUrl("sqlite:./dev.db")).toBe("sqlite");
  });

  it("tolerates surrounding whitespace, as prisma.ts does", () => {
    expect(providerForDatabaseUrl("  file:./dev.db  ")).toBe("sqlite");
  });

  it("returns null rather than guessing for an absent or unknown scheme", () => {
    expect(providerForDatabaseUrl(undefined)).toBeNull();
    expect(providerForDatabaseUrl("")).toBeNull();
    expect(providerForDatabaseUrl("mysql://u:p@h/db")).toBeNull();
  });
});

describe("parseDatasourceProvider", () => {
  it("reads the datasource block, not the generator block above it", () => {
    // Both blocks declare a `provider`; taking the first match in the file would yield
    // `prisma-client-js` on every schema this repo generates.
    const schema = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;
    expect(parseDatasourceProvider(schema)).toBe("postgresql");
  });

  it("reads a sqlite datasource", () => {
    const schema = `datasource db {\n  provider = "sqlite"\n  url = env("DATABASE_URL")\n}`;
    expect(parseDatasourceProvider(schema)).toBe("sqlite");
  });

  it("accepts the `postgres` spelling as Postgres", () => {
    const schema = `datasource db {\n  provider = "postgres"\n}`;
    expect(parseDatasourceProvider(schema)).toBe("postgresql");
  });

  it("is not fooled by the word `provider` in doc comments", () => {
    // The real schema is full of these: per-project AI provider, sandbox provider, …
    const schema = `
/// Per-project AI provider override. provider = "openai" is not a datasource.
datasource db {
  provider = "sqlite"
}
`;
    expect(parseDatasourceProvider(schema)).toBe("sqlite");
  });

  it("reports a provider this repo does not generate for as unknown, not as a guess", () => {
    expect(parseDatasourceProvider(`datasource db {\n  provider = "mysql"\n}`)).toBe("unknown");
  });

  it("returns null when there is no datasource block or no provider in it", () => {
    expect(parseDatasourceProvider('generator client {\n  provider = "x"\n}')).toBeNull();
    expect(parseDatasourceProvider('datasource db {\n  url = env("DATABASE_URL")\n}')).toBeNull();
  });
});

describe("alignedDatabaseUrl", () => {
  it("leaves a matching Postgres datasource alone", () => {
    // A developer who points the suite at a specific database keeps it.
    expect(alignedDatabaseUrl("postgresql", "postgresql://metis:metis@localhost:5432/metis")).toBe(
      null,
    );
  });

  it("leaves a matching SQLite datasource alone", () => {
    expect(alignedDatabaseUrl("sqlite", "file:./dev.db")).toBeNull();
  });

  it("supplies a Postgres URL for a Postgres client pointed at SQLite", () => {
    expect(alignedDatabaseUrl("postgresql", "file:./dev.db")).toBe(
      UNIT_TEST_POSTGRES_PLACEHOLDER_URL,
    );
  });

  it("supplies the SQLite default for a SQLite client pointed at Postgres", () => {
    expect(alignedDatabaseUrl("sqlite", "postgres://u:p@h/db")).toBe(UNIT_TEST_SQLITE_URL);
  });

  it("leaves an UNSET datasource untouched on a SQLite client", () => {
    // The default run. `prisma.ts` already resolves unset to SQLite, so there is nothing to
    // fix — and touching it would change the pre-existing suite, where several files
    // `delete process.env.DATABASE_URL` and rely on the variable being genuinely absent.
    expect(alignedDatabaseUrl("sqlite", undefined)).toBeNull();
    expect(alignedDatabaseUrl("sqlite", "  ")).toBeNull();
  });

  it("treats an UNSET datasource as SQLite when the client is Postgres", () => {
    expect(alignedDatabaseUrl("postgresql", undefined)).toBe(UNIT_TEST_POSTGRES_PLACEHOLDER_URL);
  });

  it("changes nothing when the generated provider could not be determined", () => {
    // Better to fail with Prisma's own explicit incompatibility message than to rewrite the
    // datasource on a guess.
    expect(alignedDatabaseUrl(null, "postgres://u:p@h/db")).toBeNull();
    expect(alignedDatabaseUrl("unknown", "file:./dev.db")).toBeNull();
  });

  it("changes nothing for an unrecognized scheme, so prisma.ts still fails loudly", () => {
    expect(alignedDatabaseUrl("sqlite", "mysql://u:p@h/db")).toBeNull();
    expect(alignedDatabaseUrl("postgresql", "mysql://u:p@h/db")).toBeNull();
  });

  it("synthesizes a Postgres URL that cannot reach a real database", () => {
    // Port 1 has no listener, so a unit test that unexpectedly opens a connection gets an
    // immediate, self-identifying ECONNREFUSED — never a write into a dev database.
    expect(UNIT_TEST_POSTGRES_PLACEHOLDER_URL).toMatch(/\/\/127\.0\.0\.1:1\//);
    expect(providerForDatabaseUrl(UNIT_TEST_POSTGRES_PLACEHOLDER_URL)).toBe("postgresql");
    // And carries no credentials to be mistaken for a real secret.
    expect(UNIT_TEST_POSTGRES_PLACEHOLDER_URL).not.toContain("@");
  });

  it("keeps the SQLite default identical to prisma.ts's DEFAULT_SQLITE_URL", async () => {
    const { DEFAULT_SQLITE_URL } = await import("../../../src/lib/prisma.js");
    expect(UNIT_TEST_SQLITE_URL).toBe(DEFAULT_SQLITE_URL);
  });
});

describe("readGeneratedClientProvider (against the real generated client)", () => {
  it("resolves the schema.prisma Prisma emits beside the client", () => {
    const schemaPath = generatedClientSchemaPath();
    expect(schemaPath).not.toBeNull();
    expect(existsSync(schemaPath as string)).toBe(true);
  });

  it("reports the provider that schema actually declares", () => {
    __resetGeneratedClientProviderCache();
    const schemaPath = generatedClientSchemaPath() as string;
    const expected = parseDatasourceProvider(readFileSync(schemaPath, "utf8"));
    expect(readGeneratedClientProvider()).toBe(expected);
    // Whichever provider this checkout generated for, it must be one the harness handles —
    // otherwise `pnpm test` is running on a client nothing in this repo supports.
    expect(["postgresql", "sqlite"]).toContain(expected);
  });

  it("memoizes, since setupFiles re-run for every test file in a worker", () => {
    __resetGeneratedClientProviderCache();
    const first = readGeneratedClientProvider();
    expect(readGeneratedClientProvider()).toBe(first);
  });

  it("agrees with the datasource the suite is actually running on", () => {
    // The whole point: whatever client is generated, `setup-datasource.ts` has already made
    // `DATABASE_URL` compatible with it by the time any test runs.
    expect(alignedDatabaseUrl(readGeneratedClientProvider(), process.env.DATABASE_URL)).toBeNull();
  });
});
