/**
 * Issue #642 — Unit tests for the shared `toAuthUser` mapper.
 *
 * The mapper is the single source of truth for the client-facing user object
 * returned by both `/auth/login` and `/auth/me`, so the two responses cannot
 * drift. It maps the JWT `userId` to the client `id` and never leaks `userId`.
 */
import { describe, it, expect } from "vitest";
import type { PermissionKey, RoleKey } from "@metis/shared";
import { toAuthUser } from "./auth-user.js";

const permissions: readonly PermissionKey[] = [];
const identity = {
  userId: "user_123",
  username: "alice",
  role: "developer" as RoleKey,
  permissions,
};

describe("toAuthUser", () => {
  it("maps the JWT userId to the client-facing id", () => {
    const user = toAuthUser(identity, { displayName: "Alice", email: "alice@example.com" });
    expect(user.id).toBe("user_123");
  });

  it("never exposes a userId key on the client object", () => {
    const user = toAuthUser(identity, { displayName: "Alice", email: "alice@example.com" });
    expect(Object.keys(user)).not.toContain("userId");
    expect((user as Record<string, unknown>).userId).toBeUndefined();
  });

  it("produces exactly the AuthUser key set", () => {
    const user = toAuthUser(identity, { displayName: "Alice", email: "alice@example.com" });
    expect(Object.keys(user).sort()).toEqual(
      ["displayName", "email", "id", "permissions", "role", "username"].sort(),
    );
  });

  it("carries username, role, and permissions through unchanged", () => {
    const perms: readonly PermissionKey[] = ["review.decide" as PermissionKey];
    const user = toAuthUser(
      { userId: "u1", username: "bob", role: "admin" as RoleKey, permissions: perms },
      { displayName: "Bob", email: "bob@example.com" },
    );
    expect(user.username).toBe("bob");
    expect(user.role).toBe("admin");
    expect(user.permissions).toEqual(perms);
  });

  it("defaults missing displayName/email to empty strings to honor the string contract", () => {
    const user = toAuthUser(identity, {});
    expect(user.displayName).toBe("");
    expect(user.email).toBe("");
  });

  it("coerces null displayName/email to empty strings", () => {
    const user = toAuthUser(identity, { displayName: null, email: null });
    expect(user.displayName).toBe("");
    expect(user.email).toBe("");
  });
});
