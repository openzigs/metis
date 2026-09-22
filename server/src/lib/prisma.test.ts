/**
 * Issue #539 (epic #518) — adapter selection by `DATABASE_URL` scheme.
 *
 * These tests prove the runtime Prisma adapter is chosen by the URL scheme
 * (the keystone multi-replica fix): Postgres for `postgres(ql)://`, the
 * embedded better-sqlite3 adapter for `file:`/`sqlite:`, and a loud error for
 * anything else. Adapter construction is lazy (no DB connection), so we can
 * assert the concrete factory's `provider` field without a live database.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SQLITE_URL,
  POSTGRES_CLIENT_ENV,
  redactDatabaseUrl,
  resolveDatabaseProvider,
  resolvePrismaClientClass,
  selectPrismaAdapter,
} from "./prisma.js";

const require = createRequire(import.meta.url);

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

/**
 * #45 — one image, both providers. A generated Prisma client is bound to ONE
 * provider (its `activeProvider`), and the constructor refuses a driver adapter for
 * the other. The image ships the default (SQLite) client at `@prisma/client` plus a
 * Postgres client generated to a separate directory, named by
 * `METIS_PRISMA_CLIENT_POSTGRESQL`; the class is chosen by the same scheme rule
 * that chooses the adapter.
 */
describe("resolvePrismaClientClass", () => {
  class FakePostgresClient {}
  const pgPath = "/app/server/prisma-clients/postgresql";

  it("names the env var the image sets", () => {
    expect(POSTGRES_CLIENT_ENV).toBe("METIS_PRISMA_CLIENT_POSTGRESQL");
  });

  it("uses the Postgres client from the configured directory for a Postgres URL", () => {
    const load = vi.fn(() => ({ PrismaClient: FakePostgresClient }));
    const cls = resolvePrismaClientClass("postgresql", { [POSTGRES_CLIENT_ENV]: pgPath }, load);
    expect(load).toHaveBeenCalledWith(pgPath);
    expect(cls).toBe(FakePostgresClient);
  });

  it("uses the default @prisma/client for SQLite even when the Postgres client is configured", () => {
    const load = vi.fn(() => ({ PrismaClient: FakePostgresClient }));
    const cls = resolvePrismaClientClass("sqlite", { [POSTGRES_CLIENT_ENV]: pgPath }, load);
    expect(load).not.toHaveBeenCalled();
    expect(cls).toBe(PrismaClient);
  });

  it("uses the default @prisma/client for Postgres when nothing is configured (dev: `prisma generate` per DB)", () => {
    const load = vi.fn();
    expect(resolvePrismaClientClass("postgresql", {}, load)).toBe(PrismaClient);
    expect(resolvePrismaClientClass("postgresql", { [POSTGRES_CLIENT_ENV]: "  " }, load)).toBe(
      PrismaClient,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses a relative path, which would resolve against this module rather than the cwd", () => {
    expect(() =>
      resolvePrismaClientClass(
        "postgresql",
        { [POSTGRES_CLIENT_ENV]: "prisma-clients/pg" },
        vi.fn(),
      ),
    ).toThrow(/must be an absolute path/);
  });

  it("fails loud when the configured directory holds no PrismaClient", () => {
    expect(() =>
      resolvePrismaClientClass("postgresql", { [POSTGRES_CLIENT_ENV]: pgPath }, () => ({})),
    ).toThrow(/exports no PrismaClient/);
  });

  it("fails loud, naming the variable, when the configured directory cannot be loaded", () => {
    const load = () => {
      throw new Error("Cannot find module");
    };
    expect(() =>
      resolvePrismaClientClass("postgresql", { [POSTGRES_CLIENT_ENV]: pgPath }, load),
    ).toThrow(/METIS_PRISMA_CLIENT_POSTGRESQL.*Cannot find module/s);
  });

  it("loads a real generated client directory through the default loader", () => {
    // The default loader is `require` from this module. Point it at the generated
    // client @prisma/client itself re-exports, so the test needs no second generate.
    const generated = require.resolve(".prisma/client/default", {
      paths: [path.dirname(require.resolve("@prisma/client/package.json"))],
    });
    const cls = resolvePrismaClientClass("postgresql", {
      [POSTGRES_CLIENT_ENV]: path.dirname(generated),
    });
    expect(cls).toBe(PrismaClient);
  });
});
