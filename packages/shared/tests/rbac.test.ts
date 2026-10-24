/**
 * `ROLE_PERMISSIONS` invariants, and the PR-review grants decided on #1472.
 */
import { describe, expect, it } from "vitest";
import {
  PERMISSION_KEYS,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  getPermissionsForRole,
  hasPermission,
  type PermissionKey,
} from "../src/rbac.js";

const holders = (permission: PermissionKey) =>
  ROLE_KEYS.filter((role) => hasPermission(role, permission));

describe("ROLE_PERMISSIONS", () => {
  it("gives admin every permission", () => {
    expect([...ROLE_PERMISSIONS.admin].sort()).toEqual([...PERMISSION_KEYS].sort());
  });

  it("gives reader no *.write, *.publish, *.delete or *.manage permission", () => {
    const writes = ROLE_PERMISSIONS.reader.filter((p) =>
      /\.(write|publish|delete|manage)$/.test(p),
    );
    expect(writes).toEqual([]);
  });

  it("lists only known permission keys, each once", () => {
    for (const role of ROLE_KEYS) {
      const perms = getPermissionsForRole(role);
      for (const p of perms) expect(PERMISSION_KEYS).toContain(p);
      expect(new Set(perms).size).toBe(perms.length);
    }
  });
});

describe("PR-review permissions (#1472)", () => {
  it("lets every role read a project's PR reviews", () => {
    expect(holders("pr.review.read")).toEqual(["admin", "coordinator", "developer", "reader"]);
  });

  it("lets admin and coordinator re-run a review, and nobody else", () => {
    expect(holders("pr.review.manage")).toEqual(["admin", "coordinator"]);
  });

  it("keeps the manual run-review trigger (pr.review) admin-only", () => {
    expect(holders("pr.review")).toEqual(["admin"]);
  });
});
