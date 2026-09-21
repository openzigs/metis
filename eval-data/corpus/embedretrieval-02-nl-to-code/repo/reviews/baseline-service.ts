/**
 * Epic #609 / Issue #620 — requirement baseline service (list, contents,
 * compare, manual create).
 *
 * A baseline is a named, IMMUTABLE set of `(requirementId, version)` pins over
 * the `RequirementVersion` append-only history substrate (epic #770) — no new
 * snapshot machinery. Auto-creation on review approval lives in
 * `review-service.ts` (#617); this module is the read/compare surface plus the
 * admin-only manual create. There is intentionally NO update or delete path:
 * a baseline is an audit artifact, and compare is read-only.
 *
 * Content "as of" a pin is reconstructed by replaying `changedFields` diffs
 * backward from the requirement's CURRENT state (`snapshotAtVersion`), so a
 * baseline renders the approved content even after later edits — the same
 * replay used by the requirement-history API. Competitor parity: DOORS Next
 * and Jama Connect couple review sign-off to baselines the same way (see
 * docs/USER_GUIDE.md).
 */
import { AppError } from "../../middleware/error-handler.js";
import { buildAuditLogData } from "../audit/audit-service.js";
import { prisma } from "../prisma.js";
import {
  applyReverse,
  computeChangedFields,
  parseChangedFields,
  pickTracked,
  type ChangedFields,
  type RequirementSnapshot,
  type VersionRow,
} from "../requirements/requirement-version-service.js";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const USER_SELECT = { id: true, username: true, displayName: true } as const;
const REVIEW_SELECT = { id: true, title: true, status: true } as const;

/** Tracked requirement fields + identity, read for snapshot reconstruction. */
const SNAPSHOT_SOURCE_SELECT = {
  id: true,
  version: true,
  title: true,
  body: true,
  priority: true,
  type: true,
  labels: true,
  storyPoints: true,
  reviewStatus: true,
  deletedAt: true,
} as const;

interface SnapshotSourceRow extends Record<string, unknown> {
  id: string;
  version: number;
  deletedAt: Date | null;
}

interface BaselineRow {
  id: string;
  projectId: string;
  reviewRequestId: string | null;
  name: string;
  description: string;
  createdById: string;
  createdAt: Date;
  createdBy: { id: string; username: string; displayName: string };
  reviewRequest: { id: string; title: string; status: string } | null;
  items: { requirementId: string; version: number }[];
}

export interface BaselinePinRef {
  requirementId: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Reconstruct the tracked snapshot AS OF `targetVersion` by replaying every
 * newer version's diff backward from the current state. A target below the
 * oldest version row yields the creation state.
 */
export function snapshotAtVersion(
  current: RequirementSnapshot,
  versionsDesc: readonly VersionRow[],
  targetVersion: number,
): RequirementSnapshot {
  let state: RequirementSnapshot = { ...current };
  for (const row of versionsDesc) {
    if (row.version > targetVersion) {
      state = applyReverse(state, parseChangedFields(row.changedFields));
    }
  }
  return state;
}

export interface PinSetDiff {
  /** In B but not in A. */
  added: BaselinePinRef[];
  /** In A but not in B. */
  removed: BaselinePinRef[];
  /** In both at different pinned versions (direction A → B). */
  changed: { requirementId: string; fromVersion: number; toVersion: number }[];
  /** In both at the same pinned version. */
  unchanged: BaselinePinRef[];
}

/** Classify two pin sets (A → B). Buckets are sorted by requirementId. */
export function diffPinSets(
  pinsA: readonly BaselinePinRef[],
  pinsB: readonly BaselinePinRef[],
): PinSetDiff {
  const mapA = new Map(pinsA.map((p) => [p.requirementId, p.version]));
  const mapB = new Map(pinsB.map((p) => [p.requirementId, p.version]));
  const diff: PinSetDiff = { added: [], removed: [], changed: [], unchanged: [] };

  for (const [requirementId, version] of mapB) {
    const fromVersion = mapA.get(requirementId);
    if (fromVersion === undefined) {
      diff.added.push({ requirementId, version });
    } else if (fromVersion !== version) {
      diff.changed.push({ requirementId, fromVersion, toVersion: version });
    } else {
      diff.unchanged.push({ requirementId, version });
    }
  }
  for (const [requirementId, version] of mapA) {
    if (!mapB.has(requirementId)) diff.removed.push({ requirementId, version });
  }

  const byId = (a: { requirementId: string }, b: { requirementId: string }) =>
    a.requirementId.localeCompare(b.requirementId);
  diff.added.sort(byId);
  diff.removed.sort(byId);
  diff.changed.sort(byId);
  diff.unchanged.sort(byId);
  return diff;
}

// ---------------------------------------------------------------------------
// Internal loaders
// ---------------------------------------------------------------------------

async function loadBaselineOr404(baselineId: string): Promise<BaselineRow> {
  const baseline = await prisma.baseline.findUnique({
    where: { id: baselineId },
    include: {
      createdBy: { select: USER_SELECT },
      reviewRequest: { select: REVIEW_SELECT },
      items: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!baseline) throw new AppError(404, "BASELINE_NOT_FOUND", "Baseline not found");
  return baseline as unknown as BaselineRow;
}

interface SnapshotSource {
  row: SnapshotSourceRow;
  versionsDesc: VersionRow[];
}

/**
 * Load the reconstruction inputs (current tracked state + full version
 * history) for a set of requirements. Soft-deleted requirements are INCLUDED
 * on purpose: a baseline is immutable audit evidence and must keep rendering
 * even after its requirements are deleted.
 */
async function loadSnapshotSources(requirementIds: string[]): Promise<Map<string, SnapshotSource>> {
  const sources = new Map<string, SnapshotSource>();
  if (requirementIds.length === 0) return sources;

  const rows = (await prisma.requirement.findMany({
    where: { id: { in: requirementIds } },
    select: SNAPSHOT_SOURCE_SELECT,
  })) as unknown as SnapshotSourceRow[];
  const versionRows = (await prisma.requirementVersion.findMany({
    where: { requirementId: { in: requirementIds } },
    orderBy: { version: "desc" },
  })) as unknown as (VersionRow & { requirementId: string })[];

  const versionsByRequirement = new Map<string, VersionRow[]>();
  for (const row of versionRows) {
    const list = versionsByRequirement.get(row.requirementId) ?? [];
    list.push(row);
    versionsByRequirement.set(row.requirementId, list);
  }
  for (const row of rows) {
    sources.set(row.id, { row, versionsDesc: versionsByRequirement.get(row.id) ?? [] });
  }
  return sources;
}

function baselineSummary(baseline: BaselineRow) {
  return {
    id: baseline.id,
    projectId: baseline.projectId,
    reviewRequestId: baseline.reviewRequestId,
    name: baseline.name,
    description: baseline.description,
    createdAt: baseline.createdAt,
    createdBy: baseline.createdBy,
    reviewRequest: baseline.reviewRequest,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listBaselines(
  projectId: string,
  page: number,
  pageSize: number,
): Promise<{ baselines: unknown[]; total: number; page: number; pageSize: number }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");

  const [rows, total] = await Promise.all([
    prisma.baseline.findMany({
      where: { projectId },
      include: {
        createdBy: { select: USER_SELECT },
        reviewRequest: { select: REVIEW_SELECT },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.baseline.count({ where: { projectId } }),
  ]);

  const baselines = rows.map((row) => {
    const { _count, ...rest } = row as unknown as BaselineRow & { _count: { items: number } };
    return { ...rest, itemCount: _count.items };
  });

  return { baselines, total, page, pageSize };
}

// ---------------------------------------------------------------------------
// Contents (requirement @ pinned version)
// ---------------------------------------------------------------------------

export async function getBaselineContents(baselineId: string): Promise<unknown> {
  const baseline = await loadBaselineOr404(baselineId);
  const sources = await loadSnapshotSources(baseline.items.map((i) => i.requirementId));

  const items = baseline.items.map((item) => {
    const source = sources.get(item.requirementId);
    return {
      requirementId: item.requirementId,
      version: item.version,
      /** Tracked fields AS OF the pinned version (replayed, never current). */
      snapshot: source
        ? snapshotAtVersion(pickTracked(source.row), source.versionsDesc, item.version)
        : null,
      /** Where the requirement is NOW, for drift context in the UI. */
      current: source
        ? {
            version: source.row.version,
            deleted: source.row.deletedAt !== null,
          }
        : null,
    };
  });

  return { baseline: baselineSummary(baseline), items };
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

export interface BaselineCompareEntry extends BaselinePinRef {
  /** Title as of the pinned version (B's pin for added/unchanged, A's for removed). */
  title: string;
}

export interface BaselineCompareResult {
  baselineA: { id: string; name: string; createdAt: Date };
  baselineB: { id: string; name: string; createdAt: Date };
  added: BaselineCompareEntry[];
  removed: BaselineCompareEntry[];
  changed: {
    requirementId: string;
    fromVersion: number;
    toVersion: number;
    title: string;
    /** Field-level diff between the two pinned snapshots. */
    changedFields: ChangedFields;
  }[];
  unchanged: BaselineCompareEntry[];
}

export async function compareBaselines(
  baselineIdA: string,
  baselineIdB: string,
): Promise<BaselineCompareResult> {
  const a = await loadBaselineOr404(baselineIdA);
  const b = await loadBaselineOr404(baselineIdB);
  if (a.projectId !== b.projectId) {
    throw new AppError(
      400,
      "BASELINE_PROJECT_MISMATCH",
      "Baselines belong to different projects and cannot be compared",
    );
  }

  const diff = diffPinSets(a.items, b.items);
  const involvedIds = [
    ...new Set(
      [...diff.added, ...diff.removed, ...diff.changed, ...diff.unchanged].map(
        (entry) => entry.requirementId,
      ),
    ),
  ];
  const sources = await loadSnapshotSources(involvedIds);

  const snapshotAt = (requirementId: string, version: number): RequirementSnapshot | null => {
    const source = sources.get(requirementId);
    if (!source) return null;
    return snapshotAtVersion(pickTracked(source.row), source.versionsDesc, version);
  };
  const titleAt = (requirementId: string, version: number): string => {
    const snapshot = snapshotAt(requirementId, version);
    const title = snapshot?.title;
    return typeof title === "string" ? title : "";
  };
  const withTitle = (pin: BaselinePinRef): BaselineCompareEntry => ({
    ...pin,
    title: titleAt(pin.requirementId, pin.version),
  });

  return {
    baselineA: { id: a.id, name: a.name, createdAt: a.createdAt },
    baselineB: { id: b.id, name: b.name, createdAt: b.createdAt },
    added: diff.added.map(withTitle),
    removed: diff.removed.map(withTitle),
    unchanged: diff.unchanged.map(withTitle),
    changed: diff.changed.map((entry) => {
      const from = snapshotAt(entry.requirementId, entry.fromVersion);
      const to = snapshotAt(entry.requirementId, entry.toVersion);
      return {
        ...entry,
        title: titleAt(entry.requirementId, entry.toVersion),
        changedFields: from && to ? computeChangedFields(from, to) : {},
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Manual create (review.admin — the only write path, and it only ADDS)
// ---------------------------------------------------------------------------

export interface CreateBaselineInput {
  name: string;
  description?: string;
  /** Optional subset; omitted = every non-deleted requirement in the project. */
  requirementIds?: string[];
}

export async function createManualBaseline(
  actorId: string,
  projectId: string,
  input: CreateBaselineInput,
): Promise<unknown> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");

  // Pin CURRENT versions, project-scoped (cross-project ids are a 404).
  const where =
    input.requirementIds && input.requirementIds.length > 0
      ? { id: { in: [...new Set(input.requirementIds)] }, projectId, deletedAt: null }
      : { projectId, deletedAt: null };
  const requirements = (await prisma.requirement.findMany({
    where,
    select: { id: true, version: true },
    orderBy: { createdAt: "asc" },
  })) as { id: string; version: number }[];

  if (input.requirementIds && input.requirementIds.length > 0) {
    const requested = new Set(input.requirementIds);
    if (requirements.length !== requested.size) {
      throw new AppError(
        404,
        "BASELINE_ITEM_NOT_FOUND",
        "One or more requirements were not found in this project",
      );
    }
  }
  if (requirements.length === 0) {
    throw new AppError(
      400,
      "EMPTY_BASELINE",
      "A baseline needs at least one requirement to pin — this project has none",
    );
  }

  try {
    // The audit row commits atomically with the baseline it evidences,
    // mirroring the auto-create path in review-service.ts.
    return await prisma.$transaction(async (tx) => {
      const created = await tx.baseline.create({
        data: {
          projectId,
          name: input.name,
          description: input.description ?? "",
          createdById: actorId,
          items: {
            create: requirements.map((r) => ({ requirementId: r.id, version: r.version })),
          },
        },
        include: {
          createdBy: { select: USER_SELECT },
          reviewRequest: { select: REVIEW_SELECT },
          items: true,
        },
      });

      await tx.auditLog.create({
        data: buildAuditLogData({
          actorId,
          action: "baseline.create",
          targetType: "baseline",
          targetId: (created as { id: string }).id,
          metadata: {
            projectId,
            manual: true,
            name: input.name,
            itemCount: requirements.length,
          },
        }),
      });

      return created;
    });
  } catch (err) {
    // Unique (projectId, name) violation → friendly conflict.
    if ((err as { code?: string }).code === "P2002") {
      throw new AppError(
        409,
        "BASELINE_NAME_TAKEN",
        "A baseline with this name already exists in the project",
      );
    }
    throw err;
  }
}
