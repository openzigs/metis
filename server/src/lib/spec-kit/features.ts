/**
 * Epic #396 (MVP-5) — per-feature directory model (`specs/NNN-slug/`).
 *
 * Each `/speckit.specify` invocation creates a new `SpecKitFeature` row plus
 * (optionally) a Git branch named `NNN-kebab-name`. The slug is monotonic
 * per project and zero-padded to 3 digits.
 *
 * Path-traversal guard: slugs are validated against `^\d{3}-[a-z0-9-]{1,80}$`
 * BEFORE any filesystem operation downstream (defence-in-depth for MVP-7).
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { SpecKitArtifactError } from "./artifacts.js";

export const SPECKIT_FEATURE_SLUG_RE = /^\d{3}-[a-z0-9-]{1,80}$/;

export interface SpecKitFeatureDto {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  status: string;
  branchName: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SpecKitFeatureRow {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  status: string;
  branchName: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: SpecKitFeatureRow): SpecKitFeatureDto {
  return {
    id: row.id,
    projectId: row.projectId,
    slug: row.slug,
    title: row.title,
    status: row.status,
    branchName: row.branchName,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Convert a free-form feature title into a kebab slug. Strips non-alphanumeric
 * characters, collapses whitespace into hyphens, lowercases, and truncates to
 * 80 chars (matching the slug-validation regex).
 */
export function kebab(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "feature"
  );
}

/**
 * Find the next monotonic NNN for a project. Reads only the highest
 * existing numeric prefix via an indexed `slug desc` query (avoids
 * scanning every feature row).
 */
export async function nextSlugNumber(projectId: string): Promise<string> {
  const rows = await prisma.specKitFeature.findMany({
    where: { projectId, slug: { contains: "-" } },
    select: { slug: true },
    orderBy: { slug: "desc" },
    take: 50,
  });
  let max = 0;
  for (const row of rows) {
    const m = /^(\d{3})-/.exec(row.slug);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }
  return String(max + 1).padStart(3, "0");
}

export interface CreateFeatureInput {
  projectId: string;
  title: string;
  /** Override slug entirely (used by `SPECIFY_FEATURE` env / tests). */
  forcedSlug?: string;
  actorId?: string | null;
}

/**
 * Create a `SpecKitFeature` with a monotonic slug. Retries on slug collision
 * (e.g. concurrent `/speckit.specify` invocations) by incrementing NNN.
 */
export async function createFeature(input: CreateFeatureInput): Promise<SpecKitFeatureDto> {
  const title = (input.title ?? "").trim() || "untitled";
  if (input.forcedSlug) {
    if (!SPECKIT_FEATURE_SLUG_RE.test(input.forcedSlug)) {
      throw new SpecKitArtifactError(
        400,
        "SPECKIT_INVALID_SLUG",
        `Slug must match ^\\d{3}-[a-z0-9-]{1,80}$ (got: ${input.forcedSlug})`,
      );
    }
    const row = await prisma.specKitFeature.create({
      data: {
        projectId: input.projectId,
        slug: input.forcedSlug,
        title,
        status: "draft",
        createdById: input.actorId ?? null,
      },
    });
    audit({
      actor: input.actorId ? { id: input.actorId } : null,
      action: "speckit.feature.created",
      target: { type: "speckit_feature", id: row.id },
      metadata: { projectId: input.projectId, slug: row.slug, forced: true },
    });
    return toDto(row);
  }

  // Auto-allocated slug — retry on collision.
  const base = kebab(title);
  for (let attempt = 0; attempt < 10; attempt++) {
    const nnn = await nextSlugNumber(input.projectId);
    const slug = `${nnn}-${base}`;
    if (!SPECKIT_FEATURE_SLUG_RE.test(slug)) {
      throw new SpecKitArtifactError(
        400,
        "SPECKIT_INVALID_SLUG",
        `Generated slug failed validation: ${slug}`,
      );
    }
    try {
      const row = await prisma.specKitFeature.create({
        data: {
          projectId: input.projectId,
          slug,
          title,
          status: "draft",
          createdById: input.actorId ?? null,
        },
      });
      audit({
        actor: input.actorId ? { id: input.actorId } : null,
        action: "speckit.feature.created",
        target: { type: "speckit_feature", id: row.id },
        metadata: { projectId: input.projectId, slug },
      });
      return toDto(row);
    } catch (err) {
      // Concurrent create raced us — try the next NNN.
      const code = (err as { code?: string }).code;
      if (code !== "P2002") throw err;
    }
  }
  throw new SpecKitArtifactError(
    500,
    "SPECKIT_FEATURE_CREATE_RETRIES_EXHAUSTED",
    "Could not allocate a unique feature slug after 10 attempts",
  );
}

export const SPECKIT_FEATURE_ARCHIVED_STATUS = "archived";

export interface ListFeaturesOptions {
  /** Include archived features in the result. Defaults to false. */
  includeArchived?: boolean;
}

export async function listFeatures(
  projectId: string,
  opts: ListFeaturesOptions = {},
): Promise<SpecKitFeatureDto[]> {
  const where: { projectId: string; status?: { not: string } } = { projectId };
  if (!opts.includeArchived) {
    where.status = { not: SPECKIT_FEATURE_ARCHIVED_STATUS };
  }
  const rows = await prisma.specKitFeature.findMany({
    where,
    orderBy: { slug: "asc" },
  });
  return rows.map(toDto);
}

export async function resolveFeatureBySlug(
  projectId: string,
  slug: string,
): Promise<SpecKitFeatureDto | null> {
  if (!SPECKIT_FEATURE_SLUG_RE.test(slug)) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_INVALID_SLUG",
      `Slug must match ^\\d{3}-[a-z0-9-]{1,80}$ (got: ${slug})`,
    );
  }
  const row = await prisma.specKitFeature.findUnique({
    where: { projectId_slug: { projectId, slug } },
  });
  return row ? toDto(row) : null;
}

export async function updateFeatureStatus(
  featureId: string,
  status: string,
  actorId?: string | null,
): Promise<void> {
  await prisma.specKitFeature.update({
    where: { id: featureId },
    data: { status },
  });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "speckit.feature.status_updated",
    target: { type: "speckit_feature", id: featureId },
    metadata: { status },
  });
}

/**
 * Idempotent helper used by the v1.2 → v1.3 migration path: every legacy
 * project-scoped artifact set is parented under a synthetic `001-legacy`
 * feature so the new per-feature routes still surface them.
 */
export async function ensureLegacyFeature(projectId: string): Promise<SpecKitFeatureDto> {
  const existing = await prisma.specKitFeature.findUnique({
    where: { projectId_slug: { projectId, slug: "001-legacy" } },
  });
  if (existing) return toDto(existing);
  return createFeature({
    projectId,
    title: "Legacy artifacts (pre-MVP-5)",
    forcedSlug: "001-legacy",
  });
}

// ---------------------------------------------------------------------------
// Issue #434 — archive / restore for `specs/NNN-slug/` directories.
// State persists on the SpecKitFeature.status column. `archive` flips status
// to `archived` and stamps the timestamp into a structured audit row;
// `restore` returns the feature to `draft` (or whatever status the caller
// requested via `restoreTo`).
// ---------------------------------------------------------------------------

export class SpecKitFeatureLifecycleError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SpecKitFeatureLifecycleError";
  }
}

export interface ArchiveFeatureInput {
  projectId: string;
  slug: string;
  actorId?: string | null;
}

export async function archiveFeature(input: ArchiveFeatureInput): Promise<SpecKitFeatureDto> {
  const feature = await resolveFeatureBySlug(input.projectId, input.slug);
  if (!feature) {
    throw new SpecKitFeatureLifecycleError(
      404,
      "SPECKIT_FEATURE_NOT_FOUND",
      `Feature ${input.slug} not found`,
    );
  }
  if (feature.status === SPECKIT_FEATURE_ARCHIVED_STATUS) {
    return feature;
  }
  const previousStatus = feature.status;
  const row = await prisma.specKitFeature.update({
    where: { id: feature.id },
    data: { status: SPECKIT_FEATURE_ARCHIVED_STATUS },
  });
  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: "speckit.feature.archived",
    target: { type: "speckit_feature", id: feature.id },
    metadata: {
      projectId: input.projectId,
      slug: input.slug,
      previousStatus,
    },
  });
  return toDto(row);
}

export interface RestoreFeatureInput extends ArchiveFeatureInput {
  /** Status to set on restore. Defaults to `draft`. */
  restoreTo?: string;
}

export async function restoreFeature(input: RestoreFeatureInput): Promise<SpecKitFeatureDto> {
  const feature = await resolveFeatureBySlug(input.projectId, input.slug);
  if (!feature) {
    throw new SpecKitFeatureLifecycleError(
      404,
      "SPECKIT_FEATURE_NOT_FOUND",
      `Feature ${input.slug} not found`,
    );
  }
  if (feature.status !== SPECKIT_FEATURE_ARCHIVED_STATUS) {
    throw new SpecKitFeatureLifecycleError(
      409,
      "SPECKIT_FEATURE_NOT_ARCHIVED",
      `Feature ${input.slug} is not archived (status=${feature.status})`,
    );
  }
  const restoreTo = input.restoreTo ?? "draft";
  const row = await prisma.specKitFeature.update({
    where: { id: feature.id },
    data: { status: restoreTo },
  });
  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: "speckit.feature.restored",
    target: { type: "speckit_feature", id: feature.id },
    metadata: {
      projectId: input.projectId,
      slug: input.slug,
      restoredTo: restoreTo,
    },
  });
  return toDto(row);
}
