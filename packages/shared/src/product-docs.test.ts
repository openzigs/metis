/**
 * #1620 / #1647 — a resource locator says where a resource lives, never how to
 * get in.
 */
import { describe, expect, it } from "vitest";
import {
  PRODUCT_EDGE_ORIGINS,
  declareProductResourceSchema,
  locatorCarriesCredential,
  updateProductResourceSchema,
} from "./product-docs.js";

describe("resource locators", () => {
  it.each([
    ["a URL user and password", "postgres://u:pw@db/x"],
    ["a URL user alone", "https://admin@login.example.test/tenant"],
    ["a URL password holding a slash", "postgres://u:p/w@db.internal/x"],
    ["a JDBC password parameter", "jdbc:sqlserver://db:1433;databaseName=x;password=hunter2"],
    ["a query password", "mysql://db.internal/app?user=u&password=pw"],
    ["a query token", "https://bucket.example.test/x?sig=abc"],
    ["an Oracle user/password", "scott/tiger@orcl"],
    ["an Oracle thin user/password", "jdbc:oracle:thin:scott/tiger@db:1521:orcl"],
    ["a scheme-less user:password", "u:p@db.internal:5432"],
    ["a scheme-less password holding a slash", "u:p/w@db.internal"],
  ])("refuses %s", (_label, locator) => {
    expect(locatorCarriesCredential(locator)).toBe(true);
    expect(
      declareProductResourceSchema.safeParse({ kind: "database", name: "db", locator }).success,
    ).toBe(false);
    expect(updateProductResourceSchema.safeParse({ locator }).success).toBe(false);
  });

  it.each([
    ["host:port/database", "db.internal:5432/ledger"],
    ["a URL with no user", "https://login.example.test/tenant"],
    ["a bucket path", "s3://exports-bucket/daily"],
    ["a JDBC URL with no credentials", "jdbc:postgresql://db:5432/app?ssl=true"],
    ["an Oracle thin URL with no user", "jdbc:oracle:thin:@//db:1521/svc"],
    ["a schema path", "pg-main/public"],
    ["a topic ARN", "arn:aws:sns:eu-west-1:123456789012:orders"],
    ["a parameter that is no secret", "jdbc:sqlserver://db;passthrough=true"],
  ])("accepts %s", (_label, locator) => {
    expect(locatorCarriesCredential(locator)).toBe(false);
    expect(
      declareProductResourceSchema.safeParse({ kind: "database", name: "db", locator }).success,
    ).toBe(true);
  });

  it("names the overridden origin (#1647)", () => {
    expect(PRODUCT_EDGE_ORIGINS).toEqual(["detected", "declared", "overridden"]);
  });

  it("scans a hostile locator in linear time (#1647)", () => {
    const hostile = ":a/".repeat(60_000);
    const t0 = performance.now();
    locatorCarriesCredential(hostile);
    expect(performance.now() - t0).toBeLessThan(1000);

    // zod runs the refine even after `.max` fails; the guard keeps it cheap.
    const t1 = performance.now();
    const r = declareProductResourceSchema.safeParse({
      kind: "database",
      name: "db",
      locator: hostile,
    });
    expect(performance.now() - t1).toBeLessThan(1000);
    expect(r.success).toBe(false);
  });
});
