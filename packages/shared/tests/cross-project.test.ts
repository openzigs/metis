/**
 * Cross-project pure-helper tests — Epic #295 Phase 4 (#307/#308).
 *
 * Covers the dedupe-key + rollup logic that is the runtime source of truth for
 * collapsing the same physical DB across projects and rolling per-project usage
 * classes into a canonical class. These functions are pure — no DB, no network.
 */
import { describe, expect, it } from "vitest";
import {
  databaseResourceKey,
  hasResourceIdentity,
  rollupUsageClass,
} from "../src/cross-project.js";

describe("hasResourceIdentity", () => {
  it("is true only when host AND databaseName are both non-empty", () => {
    expect(
      hasResourceIdentity({ driver: "postgres", host: "h", port: 5432, databaseName: "d" }),
    ).toBe(true);
  });

  it("is false when host is null", () => {
    expect(
      hasResourceIdentity({ driver: "sqlite", host: null, port: null, databaseName: "d" }),
    ).toBe(false);
  });

  it("is false when databaseName is null", () => {
    expect(
      hasResourceIdentity({ driver: "postgres", host: "h", port: 5432, databaseName: null }),
    ).toBe(false);
  });

  it("is false when host or db is empty string", () => {
    expect(hasResourceIdentity({ driver: "postgres", host: "", port: 1, databaseName: "d" })).toBe(
      false,
    );
    expect(hasResourceIdentity({ driver: "postgres", host: "h", port: 1, databaseName: "" })).toBe(
      false,
    );
  });
});

describe("databaseResourceKey", () => {
  it("returns the same key for the same physical DB in different projects of one workspace", () => {
    const k1 = databaseResourceKey("ws-1", {
      driver: "postgres",
      host: "db.internal",
      port: 5432,
      databaseName: "sales",
    });
    const k2 = databaseResourceKey("ws-1", {
      driver: "postgres",
      host: "db.internal",
      port: 5432,
      databaseName: "sales",
    });
    expect(k1).toBe(k2);
    expect(k1).toBe("dbres:ws-1:postgres:db.internal:5432:sales");
  });

  it("returns different keys across workspaces (tenant isolation in the key itself)", () => {
    const parts = { driver: "postgres", host: "db", port: 5432, databaseName: "x" };
    expect(databaseResourceKey("ws-A", parts)).not.toBe(databaseResourceKey("ws-B", parts));
  });

  it("distinguishes different physical DBs (host/port/db)", () => {
    const base = { driver: "postgres", host: "h", port: 5432, databaseName: "d" };
    expect(databaseResourceKey("w", base)).not.toBe(
      databaseResourceKey("w", { ...base, host: "h2" }),
    );
    expect(databaseResourceKey("w", base)).not.toBe(
      databaseResourceKey("w", { ...base, port: 5433 }),
    );
    expect(databaseResourceKey("w", base)).not.toBe(
      databaseResourceKey("w", { ...base, databaseName: "d2" }),
    );
  });

  it("normalizes a null port to an empty bucket distinct from an explicit port", () => {
    const noPort = databaseResourceKey("w", {
      driver: "mysql",
      host: "h",
      port: null,
      databaseName: "d",
    });
    expect(noPort).toBe("dbres:w:mysql:h::d");
    expect(noPort).not.toBe(
      databaseResourceKey("w", { driver: "mysql", host: "h", port: 3306, databaseName: "d" }),
    );
  });

  it("returns null when identity is insufficient (do not link)", () => {
    expect(
      databaseResourceKey("w", { driver: "sqlite", host: null, port: null, databaseName: "local" }),
    ).toBeNull();
  });
});

describe("rollupUsageClass", () => {
  it("rolls up to used when ANY project uses the object", () => {
    expect(rollupUsageClass(["unreferenced", "used", "uncertain"])).toBe("used");
  });

  it("prefers uncertain over unreferenced when no project uses it", () => {
    expect(rollupUsageClass(["unreferenced", "uncertain"])).toBe("uncertain");
  });

  it("is unreferenced only when every project is unreferenced", () => {
    expect(rollupUsageClass(["unreferenced", "unreferenced"])).toBe("unreferenced");
  });

  it("defaults to unreferenced for empty input", () => {
    expect(rollupUsageClass([])).toBe("unreferenced");
  });
});
