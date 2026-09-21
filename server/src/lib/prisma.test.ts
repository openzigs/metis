/**
 * Issue #539 (epic #518) — adapter selection by `DATABASE_URL` scheme.
 *
 * These tests prove the runtime Prisma adapter is chosen by the URL scheme
 * (the keystone multi-replica fix): Postgres for `postgres(ql)://`, the
 * embedded better-sqlite3 adapter for `file:`/`sqlite:`, and a loud error for
 * anything else. Adapter construction is lazy (no DB connection), so we can
 * assert the concrete factory's `provider` field without a live database.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SQLITE_URL,
  redactDatabaseUrl,
  resolveDatabaseProvider,
  selectPrismaAdapter,
} from "./prisma.js";

describe("resolveDatabaseProvider", () => {
  it("classifies postgres:// as postgresql", () => {
    expect(resolveDatabaseProvider("postgres://u:p@host:5432/db")).toBe("postgresql");
  });

  it("classifies postgresql:// as postgresql", () => {
    expect(resolveDatabaseProvider("postgresql://u:p@host:5432/db")).toBe("postgresql");
  });

  it("classifies file: as sqlite", () => {
    expect(resolveDatabaseProvider("file:./dev.db")).toBe("sqlite");
  });

  it("classifies sqlite: as sqlite", () => {
    expect(resolveDatabaseProvider("sqlite:./dev.db")).toBe("sqlite");
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveDatabaseProvider("  postgres://host/db  ")).toBe("postgresql");
  });

  it("throws loudly on an unrecognized scheme", () => {
    expect(() => resolveDatabaseProvider("mysql://host/db")).toThrow(
      /Unsupported DATABASE_URL scheme/,
    );
  });

  it("redacts credentials from the unknown-scheme error message", () => {
    expect(() => resolveDatabaseProvider("mysql://admin:s3cret@host/db")).toThrow(
      /^(?!.*s3cret).*Unsupported DATABASE_URL scheme/s,
    );
  });

  it("throws on an empty / schemeless string", () => {
    expect(() => resolveDatabaseProvider("not-a-url")).toThrow(/Unsupported DATABASE_URL scheme/);
  });

  describe("env-var default", () => {
    const original = process.env.DATABASE_URL;
    afterEach(() => {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    });

    it("falls back to the default SQLite URL when DATABASE_URL is unset", () => {
      delete process.env.DATABASE_URL;
      expect(resolveDatabaseProvider()).toBe("sqlite");
    });

    it("reads DATABASE_URL from the environment when no arg is given", () => {
      process.env.DATABASE_URL = "postgres://host/db";
      expect(resolveDatabaseProvider()).toBe("postgresql");
    });
  });
});

describe("selectPrismaAdapter", () => {
  it("returns a Postgres adapter for postgres:// URLs", () => {
    const adapter = selectPrismaAdapter("postgres://u:p@host:5432/db");
    expect(adapter).toBeInstanceOf(PrismaPg);
    expect(adapter.provider).toBe("postgres");
  });

  it("returns a Postgres adapter for postgresql:// URLs", () => {
    const adapter = selectPrismaAdapter("postgresql://u:p@host:5432/db");
    expect(adapter).toBeInstanceOf(PrismaPg);
    expect(adapter.provider).toBe("postgres");
  });

  it("returns the better-sqlite3 adapter for file: URLs", () => {
    const adapter = selectPrismaAdapter("file:./dev.db");
    expect(adapter).toBeInstanceOf(PrismaBetterSqlite3);
    expect(adapter.provider).toBe("sqlite");
  });

  it("returns the better-sqlite3 adapter for sqlite: URLs", () => {
    const adapter = selectPrismaAdapter("sqlite::memory:");
    expect(adapter).toBeInstanceOf(PrismaBetterSqlite3);
    expect(adapter.provider).toBe("sqlite");
  });

  it("throws on an unrecognized scheme rather than silently defaulting", () => {
    expect(() => selectPrismaAdapter("mongodb://host/db")).toThrow(
      /Unsupported DATABASE_URL scheme/,
    );
  });

  describe("env-var default", () => {
    const original = process.env.DATABASE_URL;
    afterEach(() => {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    });

    it("uses the default SQLite adapter when DATABASE_URL is unset", () => {
      delete process.env.DATABASE_URL;
      const adapter = selectPrismaAdapter();
      expect(adapter).toBeInstanceOf(PrismaBetterSqlite3);
    });
  });
});

describe("redactDatabaseUrl", () => {
  it("strips user:pass from a postgres URL", () => {
    const redacted = redactDatabaseUrl("postgres://admin:s3cret@host:5432/db");
    expect(redacted).not.toContain("s3cret");
    expect(redacted).not.toContain("admin");
    expect(redacted).toContain("host");
  });

  it("strips a user:pass@ segment from a non-standard URL", () => {
    const redacted = redactDatabaseUrl("weird://admin:s3cret@host/db");
    expect(redacted).not.toContain("s3cret");
  });

  it("leaves a credential-free file: URL intact", () => {
    expect(redactDatabaseUrl(DEFAULT_SQLITE_URL)).toBe(DEFAULT_SQLITE_URL);
  });
});
