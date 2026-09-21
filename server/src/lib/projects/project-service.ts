/**
 * Project service (Phase 5 / issue #38).
 *
 * Thin wrapper around Prisma that enforces the lifecycle (`draft → active →
 * archived`) and the RBAC rule "only the project owner OR an admin can
 * archive". Soft-archive is implemented by setting `status = "archived"` (we
 * do not flip `deletedAt` here — that is reserved for hard-deletes triggered
 * by the future delete endpoint).
 *
 * Archiving fires a registered cleanup hook (see `onArchive`) which the
 * knowledge service uses to drop the project's vector table.
 */
import {
  type CreateProjectInput,
  type DatabaseAwareAnalysisSetting,
  type ProjectStatus,
  type SqlLineageSetting,
  DATABASE_AWARE_ANALYSIS_SETTINGS,
  PROJECT_STATUSES,
  SQL_LINEAGE_SETTINGS,
  type RoleKey,
  type UpdateProjectInput,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { SUPPORTED_PROVIDER_KEYS } from "../ai/config.js";
import { audit } from "../audit/audit-service.js";
import { resolveProjectDatabaseAwareState } from "../analysis/schema-impact-producer.js";
import {
  resolveProjectSqlLineage,
  type SqlLineageReason,
} from "../code-graph/sql-lineage-resolver.js";
import { isSqlLineageSidecarConfigured } from "../code-graph/sql-lineage-client.js";

export class ProjectError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ProjectError";
    this.status = status;
    this.code = code;
  }
}

export interface ProjectActor {
  id: string;
  role: RoleKey;
}

export type ArchiveHook = (projectId: string) => void | Promise<void>;

const archiveHooks: ArchiveHook[] = [];

/** Register a side-effect to run when a project is archived. Idempotent. */
export function onArchive(hook: ArchiveHook): void {
  if (!archiveHooks.includes(hook)) archiveHooks.push(hook);
}

/** Test helper — drop all registered hooks. */
export function __resetArchiveHooks(): void {
  archiveHooks.length = 0;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export async function createProject(input: CreateProjectInput, actor: ProjectActor) {
  const slug = input.slug.toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new ProjectError(400, "INVALID_SLUG", "slug must be lowercase alphanumeric/hyphen");
  }
  const status = (input.status ?? "draft") as ProjectStatus;
  if (!PROJECT_STATUSES.includes(status)) {
    throw new ProjectError(
      400,
      "INVALID_STATUS",
      `status must be one of ${PROJECT_STATUSES.join("|")}`,
    );
  }
  const existing = await prisma.project.findUnique({ where: { slug } });
  if (existing) {
    throw new ProjectError(409, "SLUG_TAKEN", `slug '${slug}' already exists`);
  }
  const aiProviderId = normalizeAiProviderId(input.aiProviderId);
  const aiModel = normalizeAiModel(input.aiModel);
  return prisma.project.create({
    data: {
      name: input.name,
      slug,
      description: input.description ?? "",
      status,
      aiProviderId,
      aiModel,
      createdById: actor.id,
      workspaceId: (input as { workspaceId?: string }).workspaceId ?? null,
    },
  });
}

export async function updateProject(input: UpdateProjectInput, actor: ProjectActor) {
  const project = await getProjectOrThrow(input.id);
  assertCanMutate(project, actor);
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.slug !== undefined) {
    const slug = input.slug.toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw new ProjectError(400, "INVALID_SLUG", "slug must be lowercase alphanumeric/hyphen");
    }
    if (slug !== project.slug) {
      const conflict = await prisma.project.findUnique({ where: { slug } });
      if (conflict) {
        throw new ProjectError(409, "SLUG_TAKEN", `slug '${slug}' already exists`);
      }
    }
    data.slug = slug;
  }
  if (input.status !== undefined) {
    assertValidTransition(project.status as ProjectStatus, input.status);
    if (input.status === "archived") assertCanArchive(project, actor);
    data.status = input.status;
  }
  if (input.aiProviderId !== undefined) {
    const next = normalizeAiProviderId(input.aiProviderId);
    if (next !== (project as { aiProviderId?: string | null }).aiProviderId) {
      data.aiProviderId = next;
    }
  }
  if (input.aiModel !== undefined) {
    const next = normalizeAiModel(input.aiModel);
    if (next !== (project as { aiModel?: string | null }).aiModel) {
      data.aiModel = next;
    }
  }
  const updated = await prisma.project.update({
    where: { id: input.id },
    data,
  });
  if (data.aiProviderId !== undefined) {
    audit({
      actor: { id: actor.id },
      action: "project.aiProvider.update",
      target: { type: "project", id: input.id },
      metadata: {
        previous: (project as { aiProviderId?: string | null }).aiProviderId ?? null,
        next: data.aiProviderId,
      },
    });
  }
  if (data.aiModel !== undefined) {
    audit({
      actor: { id: actor.id },
      action: "project.aiModel.update",
      target: { type: "project", id: input.id },
      metadata: {
        previous: (project as { aiModel?: string | null }).aiModel ?? null,
        next: data.aiModel,
      },
    });
  }
  if (input.status === "archived") {
    await fireArchiveHooks(input.id);
  }
  return updated;
}

export async function archiveProject(projectId: string, actor: ProjectActor) {
  const project = await getProjectOrThrow(projectId);
  assertCanArchive(project, actor);
  if (project.status === "archived") return project;
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { status: "archived" },
  });
  await fireArchiveHooks(projectId);
  return updated;
}

export async function deleteProject(projectId: string, actor: ProjectActor) {
  const project = await getProjectOrThrow(projectId);
  assertCanArchive(project, actor); // same RBAC rule
  await prisma.project.update({
    where: { id: projectId },
    data: { deletedAt: new Date(), status: "archived" },
  });
  await fireArchiveHooks(projectId);
}

export async function getProject(projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
}

export async function listProjects(
  opts: { status?: ProjectStatus; limit?: number; offset?: number; workspaceIds?: string[] } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where: Record<string, unknown> = { deletedAt: null };
  if (opts.status) where.status = opts.status;
  if (opts.workspaceIds !== undefined) {
    // Scope to the caller's workspaces, but always include legacy projects
    // that were never assigned a workspace (workspaceId = null) so they don't
    // silently disappear before the backfill runs.
    where.OR = [{ workspaceId: { in: opts.workspaceIds } }, { workspaceId: null }];
  }
  const [items, total] = await Promise.all([
    prisma.project.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.project.count({ where }),
  ]);
  return { items, total, limit, offset };
}

async function getProjectOrThrow(projectId: string) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
  if (!project) throw new ProjectError(404, "PROJECT_NOT_FOUND", "Project not found");
  return project;
}

// NOTE (#673): this is the intra-workspace *role* check only. The cross-tenant
// boundary — including the `coordinator` short-circuit below — is enforced
// upstream by `assertProjectAccess` (custom-agents/authz.ts) on the PATCH
// /projects/:id route, which 404s a caller whose workspaces do not include the
// project's workspace before this function runs. Keep the coordinator branch so
// a coordinator can still mutate any project *within their own workspace*.
function assertCanMutate(project: { createdById: string }, actor: ProjectActor): void {
  if (actor.role === "admin") return;
  if (actor.role === "reader") {
    throw new ProjectError(403, "FORBIDDEN", "Reader cannot mutate projects");
  }
  if (project.createdById !== actor.id && actor.role !== "coordinator") {
    throw new ProjectError(403, "FORBIDDEN", "Only the project owner or admin can mutate");
  }
}

function assertCanArchive(project: { createdById: string }, actor: ProjectActor): void {
  if (actor.role === "admin") return;
  if (project.createdById !== actor.id) {
    throw new ProjectError(403, "FORBIDDEN", "Only the project owner or admin can archive");
  }
}

function assertValidTransition(from: ProjectStatus, to: string): asserts to is ProjectStatus {
  if (!(PROJECT_STATUSES as readonly string[]).includes(to)) {
    throw new ProjectError(
      400,
      "INVALID_STATUS",
      `status must be one of ${PROJECT_STATUSES.join("|")}`,
    );
  }
  // draft → active → archived. No backwards transitions.
  const allowed: Record<ProjectStatus, ProjectStatus[]> = {
    draft: ["draft", "active", "archived"],
    active: ["active", "archived"],
    archived: ["archived"],
  };
  if (!allowed[from].includes(to as ProjectStatus)) {
    throw new ProjectError(
      409,
      "INVALID_TRANSITION",
      `cannot transition project from '${from}' to '${to}'`,
    );
  }
}

async function fireArchiveHooks(projectId: string): Promise<void> {
  for (const hook of archiveHooks) {
    try {
      await hook(projectId);
    } catch {
      // Hooks are best-effort — failure should not block the archive itself.
    }
  }
}

/**
 * Validate + normalize a per-project AI provider override (issue #134).
 *
 * Accepts either a known provider key or null/undefined (clear the override
 * → fall back to the global default at session-bind time). Anything else
 * fails fast with INVALID_AI_PROVIDER so we don't poison the AI session row.
 */
function normalizeAiProviderId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new ProjectError(400, "INVALID_AI_PROVIDER", "aiProviderId must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!(SUPPORTED_PROVIDER_KEYS as readonly string[]).includes(trimmed)) {
    throw new ProjectError(
      400,
      "INVALID_AI_PROVIDER",
      `aiProviderId must be one of ${SUPPORTED_PROVIDER_KEYS.join("|")}`,
    );
  }
  return trimmed;
}

const MAX_AI_MODEL_LENGTH = 200;

/**
 * Validate + normalize a per-project AI model id override.
 *
 * Free-form (Bedrock/Copilot model IDs are open-ended), but length-capped
 * at 200 chars. Empty / whitespace / null / undefined all collapse to null
 * meaning "use the global default at session-bind time".
 */
function normalizeAiModel(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new ProjectError(400, "INVALID_AI_MODEL", "aiModel must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_AI_MODEL_LENGTH) {
    throw new ProjectError(
      400,
      "INVALID_AI_MODEL",
      `aiModel must be ≤ ${MAX_AI_MODEL_LENGTH} characters`,
    );
  }
  return trimmed;
}

// ────────────────────────────────────────────────────────────────────────────
// Epic #164 — FinOps + safety project settings.
// ────────────────────────────────────────────────────────────────────────────

const SAFETY_MODES = ["strict", "standard", "off"] as const;
type SafetyMode = (typeof SAFETY_MODES)[number];

export async function updateProjectSafetyMode(
  projectId: string,
  safetyMode: SafetyMode,
  actor: ProjectActor,
) {
  if (!(SAFETY_MODES as readonly string[]).includes(safetyMode)) {
    throw new ProjectError(
      400,
      "INVALID_SAFETY_MODE",
      `safetyMode must be one of ${SAFETY_MODES.join("|")}`,
    );
  }
  const project = await getProjectOrThrow(projectId);
  assertCanMutate(project, actor);
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { safetyMode },
  });
  audit({
    actor: { id: actor.id },
    action: "project.safety.update",
    target: { type: "project", id: projectId },
    metadata: {
      previous: (project as { safetyMode?: string }).safetyMode ?? null,
      next: safetyMode,
    },
  });
  return updated;
}

// ────────────────────────────────────────────────────────────────────────────
// Epic #852 Phase 3 (#857) — `databaseAwareAnalysis` project setting.
// ────────────────────────────────────────────────────────────────────────────

export interface ProjectDatabaseAwareAnalysisState {
  /** The raw `Project.databaseAwareAnalysis` column value (`auto`/`on`/`off`). */
  setting: DatabaseAwareAnalysisSetting;
  /** Whether database-aware analysis is enabled for this project. */
  enabled: boolean;
  /** Whether it will actually run (distinct from `enabled` — see resolver docs). */
  ran: boolean;
  /** Machine-readable reason the resolver arrived at this decision. */
  reason: string;
  /**
   * Whether the project currently has schema data (a connected
   * `DatabaseConnection` or a non-empty schema graph) — surfaced so the UI can
   * show a "connect a database or re-ingest" hint instead of a silent no-op.
   */
  hasSchemaData: boolean;
}

/**
 * Read the project's raw `databaseAwareAnalysis` setting AND the resolved
 * decision (`enabled`/`ran`/`reason`/`hasSchemaData`) in one call, reusing the
 * SAME resolver wiring (`resolveProjectDatabaseAwareState`, #854/#856) the
 * analysis run path and gap-report path already call — never a fourth
 * hand-rolled implementation of the coupling logic (epic #852's whole point).
 */
export async function getProjectDatabaseAwareAnalysis(
  projectId: string,
): Promise<ProjectDatabaseAwareAnalysisState> {
  await getProjectOrThrow(projectId);
  return resolveProjectDatabaseAwareState(projectId, prisma);
}

/**
 * Validate + persist a per-project `databaseAwareAnalysis` override
 * (`auto`/`on`/`off`). Mirrors `updateProjectSafetyMode`'s shape (defense-in-
 * depth whitelist re-check even though the route already validates via the
 * shared `databaseAwareAnalysisSettingSchema` — OWASP A03: never trust a
 * value has already been validated by the time it reaches the service layer)
 * plus the same owner/admin/coordinator mutate check and audit trail.
 */
export async function updateProjectDatabaseAwareAnalysis(
  projectId: string,
  databaseAwareAnalysis: DatabaseAwareAnalysisSetting,
  actor: ProjectActor,
) {
  if (!(DATABASE_AWARE_ANALYSIS_SETTINGS as readonly string[]).includes(databaseAwareAnalysis)) {
    throw new ProjectError(
      400,
      "INVALID_DATABASE_AWARE_ANALYSIS_SETTING",
      `databaseAwareAnalysis must be one of ${DATABASE_AWARE_ANALYSIS_SETTINGS.join("|")}`,
    );
  }
  const project = await getProjectOrThrow(projectId);
  assertCanMutate(project, actor);
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { databaseAwareAnalysis },
  });
  audit({
    actor: { id: actor.id },
    action: "project.databaseAwareAnalysis.update",
    target: { type: "project", id: projectId },
    metadata: {
      previous: (project as { databaseAwareAnalysis?: string }).databaseAwareAnalysis ?? null,
      next: databaseAwareAnalysis,
    },
  });
  return updated;
}

// ────────────────────────────────────────────────────────────────────────────
// Epic #882 Phase 3 (#894) — `sqlLineage` project setting.
// ────────────────────────────────────────────────────────────────────────────

export interface ProjectSqlLineageState {
  /** The raw `Project.sqlLineage` column value (`auto`/`on`/`off`). */
  setting: SqlLineageSetting;
  /** Whether the non-ORM SQL-lineage extraction pass is enabled for this project. */
  enabled: boolean;
  /** Machine-readable reason the resolver arrived at this decision. */
  reason: SqlLineageReason;
  /**
   * Best-effort static signal that the sidecar's shared secret is configured
   * (no network probe) — surfaced so the UI can show "enabled, but the
   * sidecar looks unconfigured" instead of a silent no-op (#894 acceptance
   * criterion).
   */
  sidecarConfigured: boolean;
}

/**
 * Read the project's raw `sqlLineage` setting AND the resolved decision
 * (`enabled`/`reason`) in one call, reusing the SAME resolver
 * (`resolveProjectSqlLineage`, #894) the ingest wiring
 * (`buildCodeGraphSchemaWiring`, `db-service.ts`) already calls — never a
 * second hand-rolled implementation of the same precedence logic.
 */
export async function getProjectSqlLineage(projectId: string): Promise<ProjectSqlLineageState> {
  await getProjectOrThrow(projectId);
  const resolved = await resolveProjectSqlLineage(projectId, prisma);
  return { ...resolved, sidecarConfigured: isSqlLineageSidecarConfigured() };
}

/**
 * Validate + persist a per-project `sqlLineage` override (`auto`/`on`/`off`).
 * Mirrors `updateProjectDatabaseAwareAnalysis`'s shape (defense-in-depth
 * whitelist re-check even though the route already validates via the shared
 * `sqlLineageSettingSchema` — OWASP A03: never trust a value has already been
 * validated by the time it reaches the service layer) plus the same
 * owner/admin/coordinator mutate check and audit trail.
 */
export async function updateProjectSqlLineage(
  projectId: string,
  sqlLineage: SqlLineageSetting,
  actor: ProjectActor,
) {
  if (!(SQL_LINEAGE_SETTINGS as readonly string[]).includes(sqlLineage)) {
    throw new ProjectError(
      400,
      "INVALID_SQL_LINEAGE_SETTING",
      `sqlLineage must be one of ${SQL_LINEAGE_SETTINGS.join("|")}`,
    );
  }
  const project = await getProjectOrThrow(projectId);
  assertCanMutate(project, actor);
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { sqlLineage },
  });
  audit({
    actor: { id: actor.id },
    action: "project.sqlLineage.update",
    target: { type: "project", id: projectId },
    metadata: {
      previous: (project as { sqlLineage?: string }).sqlLineage ?? null,
      next: sqlLineage,
    },
  });
  return updated;
}

export async function updateProjectBudget(
  projectId: string,
  monthlyTokenBudget: number | null,
  actor: ProjectActor,
) {
  // Admin-only — caller MUST also enforce `admin.write` permission at the
  // route layer, but we double-check the role here so service-layer callers
  // (jobs, scripts) cannot bypass it.
  if (actor.role !== "admin") {
    throw new ProjectError(403, "FORBIDDEN", "admin role required to update project budget");
  }
  if (monthlyTokenBudget != null) {
    if (!Number.isInteger(monthlyTokenBudget) || monthlyTokenBudget <= 0) {
      throw new ProjectError(
        400,
        "INVALID_BUDGET",
        "monthlyTokenBudget must be a positive integer or null",
      );
    }
  }
  const project = await getProjectOrThrow(projectId);
  const updated = await prisma.project.update({
    where: { id: projectId },
    data: { monthlyTokenBudget },
  });
  audit({
    actor: { id: actor.id },
    action: "project.budget.update",
    target: { type: "project", id: projectId },
    metadata: {
      previous: (project as { monthlyTokenBudget?: number | null }).monthlyTokenBudget ?? null,
      next: monthlyTokenBudget,
    },
  });
  return updated;
}

export async function updateProjectAutopilot(
  projectId: string,
  input: { enabled: boolean; costCeilingCents?: number | null },
  actor: ProjectActor,
) {
  const project = await getProjectOrThrow(projectId);
  assertCanMutate(project, actor);
  if (input.costCeilingCents != null) {
    if (!Number.isInteger(input.costCeilingCents) || input.costCeilingCents <= 0) {
      throw new ProjectError(
        400,
        "INVALID_CEILING",
        "costCeilingCents must be a positive integer or null",
      );
    }
  }
  const data: Record<string, unknown> = { autopilotEnabled: input.enabled };
  if (input.costCeilingCents !== undefined) {
    data.autopilotCostCeilingCents = input.costCeilingCents;
  }
  const updated = await prisma.project.update({ where: { id: projectId }, data });
  audit({
    actor: { id: actor.id },
    action: "project.autopilot.update",
    target: { type: "project", id: projectId },
    metadata: {
      previous: {
        enabled: (project as { autopilotEnabled?: boolean }).autopilotEnabled ?? false,
        costCeilingCents:
          (project as { autopilotCostCeilingCents?: number | null }).autopilotCostCeilingCents ??
          null,
      },
      next: { enabled: input.enabled, costCeilingCents: input.costCeilingCents ?? null },
    },
  });
  return updated;
}
