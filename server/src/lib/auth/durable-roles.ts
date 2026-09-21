import type { RoleKey } from "@metis/shared";
import { prisma } from "../prisma.js";

export const EXPLICIT_ROLE_SOURCES = ["local", "scim", "unknown"] as const;
export const DURABLE_ROLE_SOURCES = ["local", "scim", "provider", "unknown"] as const;

export type DurableRoleSource = (typeof DURABLE_ROLE_SOURCES)[number];

interface EffectiveRoleResolution {
  role: RoleKey;
  hasExplicitOverride: boolean;
}

const ROLE_PRIORITY: Record<RoleKey, number> = {
  reader: 10,
  developer: 20,
  coordinator: 30,
  admin: 99,
};

function isRoleKey(value: string | null | undefined): value is RoleKey {
  return (
    value === "reader" || value === "developer" || value === "coordinator" || value === "admin"
  );
}

function prioritizeRole(keys: readonly (string | null | undefined)[]): RoleKey {
  let best: RoleKey = "reader";
  let bestLevel = ROLE_PRIORITY[best];
  for (const key of keys) {
    if (!isRoleKey(key)) continue;
    const level = ROLE_PRIORITY[key];
    if (level > bestLevel) {
      best = key;
      bestLevel = level;
    }
  }
  return best;
}

type UserRoleWithRole = {
  source?: string | null;
  role?: { key?: string | null } | null;
};

export async function resolveDurableRole(userId: string): Promise<RoleKey> {
  return (await resolveEffectiveRole(userId)).role;
}

export function resolveEffectiveRoleFromRows(
  userRoles: readonly UserRoleWithRole[],
  authority?: string | null,
): EffectiveRoleResolution {
  const explicit = userRoles.filter((row) => row.source !== "provider");
  const hasExplicitOverride =
    explicit.length > 0 ||
    authority === "scim" ||
    authority === "explicit" ||
    authority === "revoked";
  const sourceRows = hasExplicitOverride ? explicit : userRoles;
  return {
    role: prioritizeRole(sourceRows.map((row) => row.role?.key)),
    // Missing/unknown provenance must never turn a DB assignment into an IdP grant.
    // Known authority also blocks provider-only rows left by migration or drift.
    hasExplicitOverride,
  };
}

export async function resolveEffectiveRole(userId: string): Promise<EffectiveRoleResolution> {
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { authRoleAuthority: true },
  });
  return resolveEffectiveRoleFromRows(
    await prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    }),
    user?.authRoleAuthority,
  );
}

export async function reconcileTrustedLoginRole(input: {
  userId: string;
  providerRole: RoleKey;
  authRolesInitializedAt: Date | null;
}): Promise<RoleKey> {
  // The caller's marker is only a login-time snapshot. Read the authoritative
  // marker AND roles together; a redundant pre-transaction guard hides races.
  // Serializable conflicts fail the login closed rather than overwrite grants.
  return prisma.$transaction(
    async (tx) => {
      const user = await tx.user.findFirst({
        where: { id: input.userId, status: "active", deletedAt: null },
        select: { authRolesInitializedAt: true, authRoleAuthority: true },
      });
      if (!user) throw new Error("Login user is unavailable");
      const roles = await tx.userRole.findMany({
        where: { userId: input.userId },
        include: { role: true },
      });
      const effective = resolveEffectiveRoleFromRows(roles, user.authRoleAuthority);
      if (effective.hasExplicitOverride) {
        if (!user.authRolesInitializedAt && roles.some((row) => row.source !== "provider")) {
          await tx.user.update({
            where: { id: input.userId },
            data: { authRolesInitializedAt: new Date() },
          });
        }
        return effective.role;
      }
      if (user.authRolesInitializedAt && roles.length === 0) return "reader";

      // The role vocabulary is the fixed RoleKey set, but nothing seeds `roles`
      // on a fresh database — throwing here 500s the very first login.
      const roleRow = await tx.role.upsert({
        where: { key: input.providerRole },
        update: {},
        create: { key: input.providerRole, name: input.providerRole, isSystem: true },
        select: { id: true },
      });
      await tx.userRole.deleteMany({
        where: {
          userId: input.userId,
          source: "provider",
        },
      });
      // A unique conflict must abort, never convert a concurrent explicit row.
      await tx.userRole.create({
        data: {
          userId: input.userId,
          roleId: roleRow.id,
          source: "provider",
        },
      });
      await tx.user.update({
        where: { id: input.userId },
        data: { authRolesInitializedAt: new Date() },
      });
      return input.providerRole;
    },
    { isolationLevel: "Serializable" },
  );
}
