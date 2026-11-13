/**
 * #2436 — what a requirement write needs, by what its body changes. The routes
 * themselves are driven end to end in
 * `tests/requirement-write-permission-1566.sqlite.test.ts` (every role) and
 * `tests/requirement-approve-granted-2436.sqlite.test.ts` (a granted analyst).
 */
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { RoleKey } from "@metis/shared";
import {
  requireRequirementWritePermission,
  requirementWritePermissions,
} from "./requirement-write-permission.js";
import { authorizationOf } from "../../middleware/authorization-tag.js";

describe("requirementWritePermissions", () => {
  it("a verdict alone needs requirement.approve, whatever its value", () => {
    for (const reviewStatus of ["approved", "rejected", "deferred", "draft", null]) {
      expect(requirementWritePermissions({ reviewStatus, version: 3, reason: "x" })).toEqual([
        "requirement.approve",
      ]);
    }
  });

  it("an edit needs project.update", () => {
    expect(requirementWritePermissions({ title: "T", version: 1 })).toEqual(["project.update"]);
    expect(requirementWritePermissions({ labels: [] })).toEqual(["project.update"]);
  });

  it("an edit with a verdict needs both, the verdict first", () => {
    expect(requirementWritePermissions({ body: "B", reviewStatus: "approved" })).toEqual([
      "requirement.approve",
      "project.update",
    ]);
  });

  it("an unknown key counts as an edit, so it never slips past project.update", () => {
    expect(requirementWritePermissions({ reviewStatus: "approved", sneaky: 1 })).toEqual([
      "requirement.approve",
      "project.update",
    ]);
  });

  it("a body with nothing in it, or none at all, is an empty edit", () => {
    for (const body of [{}, { version: 2 }, undefined, null, "text"]) {
      expect(requirementWritePermissions(body)).toEqual(["project.update"]);
    }
  });
});

describe("requireRequirementWritePermission", () => {
  const run = (user: { role: RoleKey } | undefined, body: unknown) => {
    const next = vi.fn();
    requireRequirementWritePermission()({ user, body } as unknown as Request, {} as Response, next);
    return next.mock.calls[0]?.[0] as { statusCode?: number; code?: string; message?: string };
  };

  it("401 without a user", () => {
    expect(run(undefined, { reviewStatus: "approved" })).toMatchObject({
      statusCode: 401,
      code: "AUTH_REQUIRED",
    });
  });

  it("names the first permission the role lacks", () => {
    expect(run({ role: "developer" }, { reviewStatus: "approved", title: "T" })).toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "Requires permission requirement.approve",
    });
    expect(run({ role: "reader" }, { title: "T" })).toMatchObject({
      message: "Requires permission project.update",
    });
  });

  it("lets a role holding what the body needs through", () => {
    expect(run({ role: "coordinator" }, { reviewStatus: "approved", title: "T" })).toBeUndefined();
    expect(run({ role: "admin" }, { title: "T" })).toBeUndefined();
  });

  it("is tagged as a permission check for the route walks", () => {
    expect(authorizationOf(requireRequirementWritePermission())).toEqual({
      kind: "permission",
      value: "requirement.approve|project.update",
    });
  });
});
