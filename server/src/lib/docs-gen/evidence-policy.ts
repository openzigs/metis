/** Trusted docs-generation policy (#1353). Never read identity from scopeFilter. */
import { z } from "zod";
import { getPermissionsForRole, type AuthPayload, type RoleKey } from "@metis/shared";
import { prisma } from "../prisma.js";
import { assertProjectAccess } from "../custom-agents/authz.js";
import { AppError } from "../../middleware/error-handler.js";
import type { AclActor } from "../rag/acl.js";
import type { AclSubject } from "@metis/shared";
import { resolveEffectiveRoleFromRows } from "../auth/durable-roles.js";
import type { Prisma } from "@prisma/client";

type PolicyDatabase = Pick<Prisma.TransactionClient, "user" | "project" | "codeGraph">;

const persistedPolicySchema = z
  .object({
    version: z.literal(1),
    principal: z.object({
      kind: z.literal("initiating-user"),
      userId: z.string().min(1),
      role: z.enum(["admin", "coordinator", "developer", "reader"]).optional(),
    }),
    sharedDocumentIds: z.array(z.string().min(1)).max(100),
    allowWebResearch: z.boolean(),
  })
  .strict();

export interface EvidencePolicy {
  projectId: string;
  generatedDocumentId: string;
  actor: AclActor;
  aclSubjects: readonly AclSubject[];
  repoConnectorId?: string;
  codeGraphId?: string;
  /** Explicit project-reference allowlist; never overrides ACL or generated exclusion. */
  sharedDocumentIds: readonly string[];
  allowWebResearch: boolean;
}

/** Called only after route authentication/permission gates, with req.user. */
export function createEvidencePolicy(
  actor: AuthPayload,
  references: { sharedDocumentIds?: string[]; allowWebResearch?: boolean } = {},
): string {
  return JSON.stringify(
    persistedPolicySchema.parse({
      version: 1,
      principal: { kind: "initiating-user", userId: actor.userId, role: actor.role },
      sharedDocumentIds: references.sharedDocumentIds ?? [],
      allowWebResearch: references.allowWebResearch ?? false,
    }),
  );
}

function isRecognizedRole(role: string | undefined): role is RoleKey {
  return role === "admin" || role === "coordinator" || role === "developer" || role === "reader";
}

export async function requireRepositoryGraph(
  projectId: string,
  repoConnectorId: string,
  db: PolicyDatabase = prisma,
): Promise<string> {
  if (!repoConnectorId.trim()) throw unavailableGraph();
  const graph = await db.codeGraph.findFirst({
    where: {
      projectId,
      repoConnectionId: repoConnectorId,
      repoConnection: { projectId, deletedAt: null },
    },
    select: { id: true },
  });
  if (!graph) throw unavailableGraph();
  return graph.id;
}

function unavailableGraph(): AppError {
  return new AppError(
    404,
    "REPOSITORY_GRAPH_UNAVAILABLE",
    "Requested repository graph is unavailable",
  );
}

/** Revalidate every execution, including background/retry. Legacy jobs fail closed. */
export async function resolveEvidencePolicy(
  doc: {
    id: string;
    projectId: string;
    scope: string;
    scopeFilter: string;
    evidencePolicy: string | null;
  },
  db: PolicyDatabase = prisma,
): Promise<EvidencePolicy> {
  const deny = (): AppError =>
    new AppError(403, "GENERATION_AUTH_UNAVAILABLE", "Generation authorization unavailable");
  let stored: z.infer<typeof persistedPolicySchema>;
  try {
    stored = persistedPolicySchema.parse(JSON.parse(doc.evidencePolicy ?? "null"));
  } catch {
    throw deny();
  }
  const user = await db.user.findFirst({
    where: { id: stored.principal.userId, status: "active", deletedAt: null },
    include: {
      roles: { include: { role: true } },
      workspaceMemberships: { select: { workspaceId: true } },
    },
  });
  if (!user) throw deny();
  const { role } = resolveEffectiveRoleFromRows(user.roles, user.authRoleAuthority);
  if (!isRecognizedRole(role) || !getPermissionsForRole(role).includes("project.update")) {
    throw deny();
  }
  const permissions = getPermissionsForRole(role);
  const project = await db.project.findFirst({
    where: { id: doc.projectId, deletedAt: null },
    select: { id: true },
  });
  if (!project) throw deny();
  await assertProjectAccess(
    {
      userId: user.id,
      username: user.username,
      role: role as RoleKey,
      permissions,
      workspaces: user.workspaceMemberships.map((m) => m.workspaceId),
    },
    doc.projectId,
    db,
  );

  let repoConnectorId: string | undefined;
  let codeGraphId: string | undefined;
  if (doc.scope === "repository") {
    let filter: { repoConnectorId: string };
    try {
      filter = z
        .object({ repoConnectorId: z.string().trim().min(1) })
        .parse(JSON.parse(doc.scopeFilter));
    } catch {
      throw unavailableGraph();
    }
    repoConnectorId = filter.repoConnectorId;
    codeGraphId = await requireRepositoryGraph(doc.projectId, repoConnectorId, db);
  }
  return {
    projectId: doc.projectId,
    generatedDocumentId: doc.id,
    actor: { userId: user.id, role },
    aclSubjects: [{ kind: "user", value: user.id }],
    repoConnectorId,
    codeGraphId,
    sharedDocumentIds: stored.sharedDocumentIds,
    allowWebResearch: stored.allowWebResearch,
  };
}

/** Guard the shared retrieval boundary, including JS callers without static types. */
export function assertEvidencePolicy(policy: EvidencePolicy, projectId: string): void {
  if (
    !policy ||
    policy.projectId !== projectId ||
    !policy.actor?.userId ||
    !policy.actor.role ||
    !policy.generatedDocumentId
  ) {
    throw new AppError(403, "GENERATION_AUTH_UNAVAILABLE", "Generation authorization unavailable");
  }
}
