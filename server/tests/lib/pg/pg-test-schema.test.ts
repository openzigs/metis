/**
 * Issue #806 — unit coverage for the pure, injection-critical parts of the per-suite
 * schema helper. The schema name is interpolated into DDL (`CREATE SCHEMA "<x>"`) and into
 * the libpq `options` string (`-c search_path=<x>,public`), neither of which is
 * parameterizable — so the identifier guard is the security-load-bearing piece and is
 * tested here without a database. The connect-time behavior (that the pin holds across a
 * pool) is proved against a REAL Postgres in the `*.integration.test.ts` suites.
 */
import { describe, expect, it } from "vitest";

import {
  assertValidSchemaName,
  isPostgresUrl,
  makeSchemaScopedPrismaClient,
  schemaScopedAdapter,
  searchPathOptions,
} from "./pg-test-schema.js";

describe("isPostgresUrl", () => {
  it("accepts both postgres schemes", () => {
    expect(isPostgresUrl("postgres://u:p@h/db")).toBe(true);
    expect(isPostgresUrl("postgresql://u:p@h/db")).toBe(true);
  });

  it("rejects non-postgres URLs", () => {
    expect(isPostgresUrl("file:./dev.db")).toBe(false);
    expect(isPostgresUrl("sqlite://x")).toBe(false);
    expect(isPostgresUrl("")).toBe(false);
    expect(isPostgresUrl("mysql://h/db")).toBe(false);
  });
});

describe("assertValidSchemaName", () => {
  it("accepts safe lowercase identifiers", () => {
    for (const ok of ["metis_it_reindex", "s", "_a", "a1", "schema_2_x"]) {
      expect(() => assertValidSchemaName(ok)).not.toThrow();
    }
  });

  it("rejects anything that could break out of the identifier", () => {
    for (const bad of [
      "1abc", // leading digit
      "Public", // uppercase (would need quoting to survive folding)
      "a-b", // hyphen
      "a b", // space -> would corrupt the libpq options string
      "a;DROP SCHEMA public", // statement injection
      'a"x', // quote injection into "<x>"
      "a,public", // extra search_path entry injection
      "", // empty
      "schéma", // non-ASCII
    ]) {
      expect(() => assertValidSchemaName(bad)).toThrow(/invalid test schema name/);
    }
  });
});

describe("searchPathOptions", () => {
  it("pins the schema first, then public, in libpq -c form", () => {
    expect(searchPathOptions("metis_it_vecstore")).toBe("-c search_path=metis_it_vecstore,public");
  });

  it("refuses an unsafe schema before building the options string", () => {
    expect(() => searchPathOptions("a,evil")).toThrow(/invalid test schema name/);
  });
});

describe("schema-scoped client builders", () => {
  it("build a PrismaPg adapter for a valid schema (construction is lazy — no connection)", () => {
    const adapter = schemaScopedAdapter("metis_it_reindex", "postgresql://u:p@h/db");
    expect(adapter).toBeDefined();
    // `@prisma/adapter-pg` exposes the underlying provider; confirm it is the pg adapter.
    expect(adapter.provider).toBe("postgres");
  });

  it("validate the schema before constructing anything", () => {
    expect(() => schemaScopedAdapter("bad;name", "postgresql://u:p@h/db")).toThrow(
      /invalid test schema name/,
    );
    expect(() => makeSchemaScopedPrismaClient("bad;name", "postgresql://u:p@h/db")).toThrow(
      /invalid test schema name/,
    );
  });
});
