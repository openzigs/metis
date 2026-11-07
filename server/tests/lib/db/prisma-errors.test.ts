import { describe, expect, it } from "vitest";
import {
  isSerializationFailure,
  isUniqueViolation,
  uniqueViolationTarget,
} from "../../../src/lib/db/prisma-errors.js";

describe("isUniqueViolation", () => {
  it("matches an error carrying Prisma's P2002 code", () => {
    expect(isUniqueViolation(Object.assign(new Error("dup"), { code: "P2002" }))).toBe(true);
  });

  it.each([
    ["another Prisma code", { code: "P2025" }],
    ["an error with no code", new Error("x")],
    ["null", null],
    ["a string", "P2002"],
  ])("rejects %s", (_label, err) => {
    expect(isUniqueViolation(err)).toBe(false);
  });
});

describe("isSerializationFailure (#1904)", () => {
  it("matches Prisma's P2034 (a refused statement inside the transaction)", () => {
    expect(isSerializationFailure(Object.assign(new Error("conflict"), { code: "P2034" }))).toBe(
      true,
    );
  });

  it.each([["40001"], ["40P01"]])(
    "matches the pg adapter's TransactionWriteConflict (a refused commit, %s)",
    (originalCode) => {
      const err = Object.assign(new Error("TransactionWriteConflict"), {
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict", originalCode },
      });
      expect(isSerializationFailure(err)).toBe(true);
    },
  );

  it.each([
    ["a unique violation", { code: "P2002" }],
    ["another adapter error kind", { cause: { kind: "UniqueConstraintViolation" } }],
    ["a null cause", { cause: null }],
    ["an error with no code", new Error("x")],
    ["null", null],
    ["a string", "P2034"],
  ])("rejects %s", (_label, err) => {
    expect(isSerializationFailure(err)).toBe(false);
  });
});

describe("uniqueViolationTarget (#463)", () => {
  const adapter = (constraint: unknown) => ({
    code: "P2002",
    meta: { driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint } } },
  });

  it("reads a Postgres adapter's index name", () => {
    expect(
      uniqueViolationTarget(adapter({ index: "repo_connections_projectId_primary_key" })),
    ).toEqual({ index: "repo_connections_projectId_primary_key" });
  });

  it("reads a SQLite adapter's column list", () => {
    expect(uniqueViolationTarget(adapter({ fields: ["projectId", "label"] }))).toEqual({
      fields: ["projectId", "label"],
    });
  });

  it("reads the classic engine's meta.target, as a name or as columns", () => {
    expect(uniqueViolationTarget({ code: "P2002", meta: { target: "idx" } })).toEqual({
      index: "idx",
    });
    expect(uniqueViolationTarget({ code: "P2002", meta: { target: ["a", "b"] } })).toEqual({
      fields: ["a", "b"],
    });
  });

  it.each([
    ["no meta", { code: "P2002" }],
    ["null", null],
    ["an empty meta", { code: "P2002", meta: {} }],
    ["a constraint naming nothing usable", adapter({ fields: [1] })],
    ["a non-string target list", { code: "P2002", meta: { target: [1] } }],
  ])("returns null for %s", (_label, err) => {
    expect(uniqueViolationTarget(err)).toBeNull();
  });
});
