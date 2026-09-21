/**
 * User, Role, Permission, AuditLog domain schemas.
 */
import { z } from "zod";
import {
  PERMISSION_KEYS,
  ROLE_KEYS,
  USER_STATUSES,
  type PermissionKey,
  type RoleKey,
} from "./constants.js";
import { dateSchema, idSchema, timestampsSchema } from "./common.js";

// ---- User ------------------------------------------------------------------
export const userSchema = z
  .object({
    id: idSchema,
    username: z.string().min(1).max(64),
    displayName: z.string().min(1).max(128),
    email: z.string().email(),
    status: z.enum(USER_STATUSES),
    lastLoginAt: dateSchema.nullable(),
    deletedAt: dateSchema.nullable(),
  })
  .merge(timestampsSchema);
export type User = z.infer<typeof userSchema>;

export const createUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_.-]+$/, "invalid username"),
  displayName: z.string().min(1).max(128),
  email: z.string().email(),
  status: z.enum(USER_STATUSES).default("active"),
  roleKeys: z.array(z.enum(ROLE_KEYS)).min(1).max(ROLE_KEYS.length),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = createUserSchema.partial().extend({ id: idSchema });
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// ---- Role ------------------------------------------------------------------
export const roleSchema = z
  .object({
    id: idSchema,
    key: z.enum(ROLE_KEYS),
    name: z.string().min(1).max(128),
    description: z.string().max(512).default(""),
    isSystem: z.boolean(),
  })
  .merge(timestampsSchema);
export type Role = z.infer<typeof roleSchema>;

// ---- Permission ------------------------------------------------------------
export const permissionSchema = z.object({
  id: idSchema,
  key: z.enum(PERMISSION_KEYS),
  description: z.string().max(512),
  createdAt: dateSchema,
});
export type Permission = z.infer<typeof permissionSchema>;

// ---- AuditLog --------------------------------------------------------------
export const auditLogSchema = z.object({
  id: idSchema,
  actorId: idSchema.nullable(),
  action: z.string().min(1).max(128),
  targetType: z.string().min(1).max(64),
  targetId: z.string().min(1).max(128),
  argsHash: z.string().max(128).nullable(),
  resultHash: z.string().max(128).nullable(),
  metadata: z.string().nullable(), // JSON-encoded
  ts: dateSchema,
});
export type AuditLog = z.infer<typeof auditLogSchema>;

export const createAuditLogSchema = z.object({
  actorId: idSchema.nullable().optional(),
  action: z.string().min(1).max(128),
  targetType: z.string().min(1).max(64),
  targetId: z.string().min(1).max(128),
  argsHash: z.string().max(128).optional(),
  resultHash: z.string().max(128).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateAuditLogInput = z.infer<typeof createAuditLogSchema>;

// Helpers for callers that want strongly-typed enums beyond the schema --------
export type { PermissionKey, RoleKey };
