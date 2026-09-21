import { describe, expect, it } from "vitest";
import {
  createUserSchema,
  updateUserSchema,
  userSchema,
  createAuditLogSchema,
  auditLogSchema,
  roleSchema,
  permissionSchema,
} from "../src/user.js";

const validId = "clxxxxxxxx0000abcd1234efgh";
const now = new Date();

describe("user domain", () => {
  describe("createUserSchema", () => {
    it("accepts a valid payload", () => {
      const parsed = createUserSchema.parse({
        username: "jane.doe",
        displayName: "Jane Doe",
        email: "jane@example.com",
        roleKeys: ["developer"],
      });
      expect(parsed.status).toBe("active");
      expect(parsed.roleKeys).toEqual(["developer"]);
    });

    it("rejects an invalid email", () => {
      expect(() =>
        createUserSchema.parse({
          username: "jane",
          displayName: "Jane",
          email: "not-an-email",
          roleKeys: ["developer"],
        }),
      ).toThrow();
    });

    it("rejects a username with illegal characters", () => {
      expect(() =>
        createUserSchema.parse({
          username: "jane doe!",
          displayName: "Jane",
          email: "jane@example.com",
          roleKeys: ["developer"],
        }),
      ).toThrow();
    });

    it("rejects empty roleKeys", () => {
      expect(() =>
        createUserSchema.parse({
          username: "jane",
          displayName: "Jane",
          email: "jane@example.com",
          roleKeys: [],
        }),
      ).toThrow();
    });

    it("rejects an unknown role key", () => {
      expect(() =>
        createUserSchema.parse({
          username: "jane",
          displayName: "Jane",
          email: "jane@example.com",
          // @ts-expect-error — testing runtime validation of unknown key
          roleKeys: ["super-admin"],
        }),
      ).toThrow();
    });
  });

  describe("updateUserSchema", () => {
    it("requires the id", () => {
      expect(() => updateUserSchema.parse({ displayName: "Jane" })).toThrow();
    });

    it("accepts a partial update with the id", () => {
      const parsed = updateUserSchema.parse({ id: validId, displayName: "Jane" });
      expect(parsed.id).toBe(validId);
    });
  });

  describe("userSchema", () => {
    it("validates a hydrated row", () => {
      expect(
        userSchema.parse({
          id: validId,
          username: "admin",
          displayName: "System Admin",
          email: "admin@metis.local",
          status: "active",
          lastLoginAt: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ status: "active" });
    });

    it("rejects an invalid status", () => {
      expect(() =>
        userSchema.parse({
          id: validId,
          username: "admin",
          displayName: "Admin",
          email: "admin@metis.local",
          status: "banned",
          lastLoginAt: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
      ).toThrow();
    });
  });

  describe("roleSchema + permissionSchema", () => {
    it("validates a role row", () => {
      expect(
        roleSchema.parse({
          id: validId,
          key: "admin",
          name: "Administrator",
          description: "Full access",
          isSystem: true,
          createdAt: now,
          updatedAt: now,
        }),
      ).toMatchObject({ key: "admin" });
    });

    it("validates a permission row", () => {
      expect(
        permissionSchema.parse({
          id: validId,
          key: "project.create",
          description: "Create projects",
          createdAt: now,
        }),
      ).toMatchObject({ key: "project.create" });
    });
  });

  describe("auditLog", () => {
    it("createAuditLogSchema accepts metadata as a record", () => {
      const parsed = createAuditLogSchema.parse({
        action: "project.create",
        targetType: "Project",
        targetId: validId,
        metadata: { ip: "127.0.0.1" },
      });
      expect(parsed.action).toBe("project.create");
    });

    it("auditLogSchema rejects an empty action", () => {
      expect(() =>
        auditLogSchema.parse({
          id: validId,
          actorId: validId,
          action: "",
          targetType: "Project",
          targetId: validId,
          argsHash: null,
          resultHash: null,
          metadata: null,
          ts: now,
        }),
      ).toThrow();
    });
  });
});
