import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../../../src/lib/db/prisma-errors.js";

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
