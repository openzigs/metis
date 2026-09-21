import { describe, expect, it } from "vitest";
import {
  POSTGRES_ADAPTER_MISSING_MESSAGE,
  createLogicalAdapter,
  requireDatabaseUrl,
  resolveLogicalProvider,
} from "./logical-adapter.js";

describe("resolveLogicalProvider", () => {
  it("defaults to sqlite when unset (matches export.mjs)", () => {
    expect(resolveLogicalProvider(undefined)).toBe("sqlite");
    expect(resolveLogicalProvider("")).toBe("sqlite");
  });

  it("normalizes postgres/postgresql (any case) to postgresql", () => {
    expect(resolveLogicalProvider("postgres")).toBe("postgresql");
    expect(resolveLogicalProvider("POSTGRESQL")).toBe("postgresql");
    expect(resolveLogicalProvider("Postgres")).toBe("postgresql");
  });

  it("treats anything else as sqlite", () => {
    expect(resolveLogicalProvider("sqlite")).toBe("sqlite");
    expect(resolveLogicalProvider("mysql")).toBe("sqlite");
  });
});

describe("createLogicalAdapter — sqlite", () => {
  it("uses the supplied sqlite adapter factory and never touches the pg import", async () => {
    let pgImportCalled = false;
    const sentinel = { __sqlite: true };
    const adapter = await createLogicalAdapter(
      "sqlite",
      "file:./x.db",
      (url) => ({ ...sentinel, url }),
      async () => {
        pgImportCalled = true;
        return {};
      },
    );
    expect(adapter).toMatchObject({ __sqlite: true, url: "file:./x.db" });
    expect(pgImportCalled).toBe(false);
  });
});

describe("createLogicalAdapter — postgresql (adapter ABSENT) fails loudly", () => {
  it("throws the actionable message when @prisma/adapter-pg is not installed", async () => {
    await expect(
      createLogicalAdapter(
        "postgresql",
        "postgresql://u@h:5432/db",
        () => ({ __sqlite: true }),
        // Simulate the package being absent — exactly what a fresh dynamic
        // import("@prisma/adapter-pg") throws when the dep is not committed.
        async () => {
          throw new Error("Cannot find package '@prisma/adapter-pg'");
        },
      ),
    ).rejects.toThrow(/Postgres logical reload requires "@prisma\/adapter-pg"/);
  });

  it("does NOT silently fall back to the sqlite adapter on a postgres provider", async () => {
    let sqliteUsed = false;
    await expect(
      createLogicalAdapter(
        "postgresql",
        "postgresql://u@h:5432/db",
        () => {
          sqliteUsed = true;
          return {};
        },
        async () => {
          throw new Error("MODULE_NOT_FOUND");
        },
      ),
    ).rejects.toThrow();
    expect(sqliteUsed).toBe(false);
  });

  it("fails loudly when the module resolves but exports no PrismaPg constructor", async () => {
    await expect(
      createLogicalAdapter(
        "postgresql",
        "postgresql://u@h:5432/db",
        () => ({}),
        async () => ({ notTheConstructor: true }),
      ),
    ).rejects.toThrow(/did not export a PrismaPg adapter constructor/);
  });

  it("constructs the adapter when @prisma/adapter-pg IS present (PrismaPg export)", async () => {
    class FakePrismaPg {
      readonly connectionString: string;
      constructor(cfg: { connectionString: string }) {
        this.connectionString = cfg.connectionString;
      }
    }
    const adapter = await createLogicalAdapter(
      "postgresql",
      "postgresql://u@h:5432/db",
      () => ({}),
      async () => ({ PrismaPg: FakePrismaPg }),
    );
    expect(adapter).toBeInstanceOf(FakePrismaPg);
    expect((adapter as FakePrismaPg).connectionString).toBe("postgresql://u@h:5432/db");
  });

  it("exposes the missing-adapter message constant for the CLIs", () => {
    expect(POSTGRES_ADAPTER_MISSING_MESSAGE).toMatch(/SQLite→SQLite is exercised in CI/);
    expect(POSTGRES_ADAPTER_MISSING_MESSAGE).toMatch(/not yet exercised in CI/);
  });
});

describe("requireDatabaseUrl — fail fast, no dev.db fallback", () => {
  it("returns the URL when set", () => {
    expect(requireDatabaseUrl({ DATABASE_URL: "file:./dev.db" } as NodeJS.ProcessEnv)).toBe(
      "file:./dev.db",
    );
  });

  it("throws (no silent dev.db fallback) when DATABASE_URL is unset", () => {
    expect(() => requireDatabaseUrl({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL is not set/);
  });

  it("throws when DATABASE_URL is blank/whitespace", () => {
    expect(() => requireDatabaseUrl({ DATABASE_URL: "   " } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL is not set/,
    );
  });
});
