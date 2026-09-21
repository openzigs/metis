import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { resolveEffectiveRoleFromRows } from "./durable-roles.js";

const identity = z.string().trim().min(1).max(200);
export const reconciliationTargetSchema = z
  .object({ targetId: identity, username: identity })
  .strict();
export const reconciliationSchema = reconciliationTargetSchema
  .extend({
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.string().uuid(),
    decision: z.enum(["provider-managed", "keep-explicit", "revoked"]),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict();
export type ReconciliationInput = z.infer<typeof reconciliationSchema>;
export type ReconciliationTarget = z.infer<typeof reconciliationTargetSchema>;
type Tx = Prisma.TransactionClient;
export type ReconciliationActor =
  | { kind: "admin"; id: string }
  | { kind: "host-operator"; name: string };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = () =>
  new AppError(409, "RECONCILIATION_CONFLICT", "State changed or request ID reused; inspect again");

async function authorize(tx: Tx, actor: ReconciliationActor, targetId: string) {
  if (actor.kind === "host-operator") return; // Only the offline wrapper supplies this discriminant.
  const user = await tx.user.findFirst({
    where: { id: actor.id, status: "active", deletedAt: null },
  });
  const roles = await tx.userRole.findMany({
    where: { userId: actor.id },
    include: { role: true },
  });
  if (!user || resolveEffectiveRoleFromRows(roles, user.authRoleAuthority).role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "An active durable administrator is required");
  }
  if (actor.id === targetId)
    throw new AppError(403, "SELF_APPROVAL", "Self reconciliation is not allowed");
}

async function snapshot(tx: Tx, target: ReconciliationTarget) {
  const user = await tx.user.findUnique({ where: { id: target.targetId } });
  if (!user) throw new AppError(404, "NOT_FOUND", "Target user not found");
  if (user.username !== target.username)
    throw new AppError(409, "IDENTITY_MISMATCH", "Target username does not match");
  const roles = await tx.userRole.findMany({
    where: { userId: user.id },
    include: { role: true },
    orderBy: { roleId: "asc" },
  });
  const state = {
    id: user.id,
    username: user.username,
    status: user.status,
    deletedAt: user.deletedAt?.toISOString() ?? null,
    initializedAt: user.authRolesInitializedAt?.toISOString() ?? null,
    updatedAt: user.updatedAt.toISOString(),
    authority: user.authRoleAuthority,
    roles: roles.map((row) => ({
      roleId: row.roleId,
      key: row.role.key,
      source: row.source,
      assignedAt: row.assignedAt.toISOString(),
    })),
  };
  return { state, fingerprint: hash(state) };
}

/** Internal transaction boundary shared by the API and the separately imported offline wrapper. */
export async function inspectRoleState(actor: ReconciliationActor, target: ReconciliationTarget) {
  return prisma.$transaction(
    async (tx) => {
      await authorize(tx, actor, target.targetId);
      return snapshot(tx, target);
    },
    { isolationLevel: "Serializable" },
  );
}

export async function confirmRoleState(actor: ReconciliationActor, input: ReconciliationInput) {
  return prisma.$transaction(
    async (tx) => {
      await authorize(tx, actor, input.targetId);
      const before = await snapshot(tx, input);
      const auditId = `auth-role-reconciliation:${input.requestId}`;
      const argsHash = hash({ actor, input });
      const previous = await tx.auditLog.findUnique({ where: { id: auditId } });
      if (previous) {
        if (previous.argsHash !== argsHash || previous.resultHash !== before.fingerprint)
          throw conflict();
        return { ...before, requestId: input.requestId, replayed: true };
      }
      if (before.fingerprint !== input.expectedFingerprint) throw conflict();
      if (before.state.status !== "active" || before.state.deletedAt) {
        throw new AppError(409, "TARGET_UNAVAILABLE", "Target must be active and not deleted");
      }
      const explicit = before.state.roles.some((row) => row.source !== "provider");
      const scim =
        before.state.authority === "scim" ||
        before.state.roles.some((row) => row.source === "scim");
      if (
        input.decision === "provider-managed" &&
        (explicit || scim || !["unknown", "provider", "revoked"].includes(before.state.authority))
      ) {
        throw new AppError(
          409,
          "EXPLICIT_AUTHORITY",
          "Explicit or SCIM authority cannot be converted to provider management",
        );
      }
      const authority = scim
        ? "scim"
        : input.decision === "provider-managed"
          ? "provider"
          : input.decision === "revoked"
            ? "revoked"
            : "explicit";
      // Monotonic even when two approvals occur in the same millisecond.
      const now = new Date(Math.max(Date.now(), new Date(before.state.updatedAt).getTime() + 1));
      const updated = await tx.user.updateMany({
        where: {
          id: input.targetId,
          username: input.username,
          updatedAt: new Date(before.state.updatedAt),
        },
        data: {
          authRoleAuthority: authority,
          authRolesInitializedAt: before.state.initializedAt
            ? new Date(before.state.initializedAt)
            : now,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) throw conflict();
      // Never delete or upsert an explicit row, even for the revoked decision.
      await tx.userRole.deleteMany({ where: { userId: input.targetId, source: "provider" } });
      if (input.decision === "provider-managed") {
        const reader = await tx.role.findUnique({ where: { key: "reader" } });
        if (!reader) throw new AppError(409, "ROLE_UNAVAILABLE", "Reader role is not configured");
        await tx.userRole.create({
          data: { userId: input.targetId, roleId: reader.id, source: "provider" },
        });
      }
      const after = await snapshot(tx, input);
      await tx.auditLog.create({
        data: {
          id: auditId,
          actorId: actor.kind === "admin" ? actor.id : null,
          action: "admin.auth.role-reconciled",
          targetType: "user",
          targetId: input.targetId,
          argsHash,
          resultHash: after.fingerprint,
          metadata: JSON.stringify({
            actor,
            target: { id: input.targetId, username: input.username },
            decision: input.decision,
            reason: input.reason,
            requestId: input.requestId,
            before: before.state,
            after: after.state,
          }),
        },
      });
      return { ...after, requestId: input.requestId, replayed: false };
    },
    { isolationLevel: "Serializable" },
  );
}

// The HTTP adapter only calls these wrappers: caller input cannot select host mode.
export const inspectRolesForAdmin = (actorId: string, target: ReconciliationTarget) =>
  inspectRoleState({ kind: "admin", id: actorId }, reconciliationTargetSchema.parse(target));
export const confirmRolesForAdmin = (actorId: string, input: ReconciliationInput) =>
  confirmRoleState({ kind: "admin", id: actorId }, reconciliationSchema.parse(input));
