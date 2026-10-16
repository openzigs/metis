/**
 * Epic #770 — Requirement version-history service.
 *
 * Provides the append-only versioning primitives for {@link Requirement}:
 *
 *   • {@link computeChangedFields} — compact diff (changed fields only).
 *   • {@link reconstructSnapshots} — replay diffs to rebuild full snapshots.
 *   • {@link updateRequirementWithHistory} — atomic update + version append.
 *   • {@link restoreRequirementVersion} — roll back to a prior version,
 *     appending a NEW version row (N+1) and never mutating history.
 *
 * The pure functions are exported independently so they can be exhaustively
 * unit-tested (round-trip diff, reconstruction) without a database.
 */
import type { PrismaClient } from "@prisma/client";
import { clearCriteriaFlag, hasCriteriaFlag } from "../analysis/clarification-criteria-flag.js";
import {
  mergeHiddenRequirementLabels,
  parseRequirementLabels,
} from "../analysis/requirement-labels.js";

/**
 * Tracked requirement fields that participate in version history. Order is
 * stable so CSV/JSON exports and reconstructed snapshots are deterministic.
 *
 * #1162 — `reviewStatus` is deliberately NOT tracked. A version is the content
 * a reviewer is asked to approve; the status is the verdict ON a version, not
 * part of it. Tracking it would make the review its own subject: submitting a
 * review pins version N and then moves the status, so every submission (and
 * every verdict) would mint a new version straight after the pin, put a
 * spurious `reviewStatus` change into every baseline compare, and let a
 * restore silently revert a verdict. Its audit trail is the review's own
 * `review.*` audit-log events, and a manual change through the edit routes is
 * audited there too. Old version rows that recorded a `reviewStatus` change
 * still parse; replay ignores the field (see {@link applyReverse}).
 */
export const TRACKED_FIELDS = [
  "title",
  "body",
  "priority",
  "type",
  "labels",
  "storyPoints",
  // #990 — editable in the Edit dialog, so versioned like the body. Stored as
  // a JSON string (like `labels`); appended last to keep the CSV columns of
  // existing exports where they were.
  "acceptanceCriteria",
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

/**
 * #1162 — the untracked columns a caller may write in the same transaction as
 * a tracked patch. They never enter a version row and never bump `version`.
 * An allowlist, so a tracked field cannot be slipped past the history as
 * "untracked" data.
 */
export const UNTRACKED_WRITABLE_FIELDS = ["reviewStatus", "externalUrl", "importSourceId"] as const;

export type UntrackedWritableField = (typeof UNTRACKED_WRITABLE_FIELDS)[number];

/** Untracked columns written alongside a tracked patch. */
export type UntrackedRequirementData = Partial<Record<UntrackedWritableField, string | null>>;

/** A snapshot of the tracked subset of a requirement. */
export type RequirementSnapshot = Record<TrackedField, unknown>;

/** A single field's before/after change. */
export interface FieldChange {
  from: unknown;
  to: unknown;
}

/** Compact diff — only changed fields, each as `{ from, to }`. */
export type ChangedFields = Record<string, FieldChange>;

/** Error thrown by the version service for predictable failure modes. */
export class RequirementVersionError extends Error {
  readonly code: "NOT_FOUND" | "INVALID_VERSION" | "VERSION_CONFLICT";
  constructor(code: "NOT_FOUND" | "INVALID_VERSION" | "VERSION_CONFLICT", message: string) {
    super(message);
    this.name = "RequirementVersionError";
    this.code = code;
  }
}

/**
 * Minimal Prisma surface this service depends on. Accepting an interface keeps
 * the service trivially mockable in unit tests and works for both the root
 * client and an interactive-transaction client.
 */
export interface VersionPrismaClient {
  $transaction: PrismaClient["$transaction"];
  requirement: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    update(args: unknown): Promise<Record<string, unknown>>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  requirementVersion: {
    create(args: unknown): Promise<Record<string, unknown>>;
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
    count(args: unknown): Promise<number>;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Equality used to decide whether a tracked field changed. Treats
 * `null`/`undefined` as equivalent (a never-set field vs. an explicit null)
 * and otherwise relies on strict equality, which is correct for the scalar +
 * JSON-string fields we track.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return false;
}

/** Normalize an `undefined` to `null` for stable, JSON-serializable diffs. */
function nullish(value: unknown): unknown {
  return value === undefined ? null : value;
}

/** Pick only the tracked fields from a wider requirement-like object. */
export function pickTracked(row: Record<string, unknown>): RequirementSnapshot {
  const out = {} as RequirementSnapshot;
  for (const field of TRACKED_FIELDS) {
    out[field] = nullish(row[field]);
  }
  return out;
}

/**
 * Compute the compact diff between two snapshots. Only fields present in
 * `after` are considered, and only those that actually changed are emitted.
 */
export function computeChangedFields(
  before: Partial<RequirementSnapshot>,
  after: Partial<RequirementSnapshot>,
): ChangedFields {
  const diff: ChangedFields = {};
  for (const field of TRACKED_FIELDS) {
    if (!(field in after)) continue;
    const to = nullish(after[field]);
    const from = nullish(before[field]);
    if (!valuesEqual(from, to)) {
      diff[field] = { from, to };
    }
  }
  return diff;
}

/** Serialize a diff for storage. */
export function serializeChangedFields(diff: ChangedFields): string {
  return JSON.stringify(diff);
}

/** Parse a stored diff back into a {@link ChangedFields}. Tolerates bad data. */
export function parseChangedFields(raw: string | null | undefined): ChangedFields {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ChangedFields;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Produce a new snapshot with each changed field reverted to its `from` value.
 * Used to roll backward through history (newest → oldest).
 */
export function applyReverse(
  state: RequirementSnapshot,
  changedFields: ChangedFields,
): RequirementSnapshot {
  const next = { ...state };
  for (const [field, change] of Object.entries(changedFields)) {
    if ((TRACKED_FIELDS as readonly string[]).includes(field)) {
      (next as Record<string, unknown>)[field] = nullish(change.from);
    }
  }
  return next;
}

/** A persisted version row (the subset this service reads). */
export interface VersionRow {
  version: number;
  changedFields: string;
  actorId: string | null;
  reason: string | null;
  createdAt: Date | string;
}

/**
 * Rebuild the full tracked snapshot as-of every version by replaying diffs
 * backward from the requirement's current state.
 *
 * @param current      Current tracked snapshot (== state at the highest version).
 * @param versionsDesc ALL version rows, ordered by `version` DESC.
 * @returns Map of `version → snapshot` (snapshot is the state including that
 *          version's change).
 */
export function reconstructSnapshots(
  current: RequirementSnapshot,
  versionsDesc: VersionRow[],
): Map<number, RequirementSnapshot> {
  const out = new Map<number, RequirementSnapshot>();
  let running: RequirementSnapshot = { ...current };
  for (const row of versionsDesc) {
    out.set(row.version, { ...running });
    running = applyReverse(running, parseChangedFields(row.changedFields));
  }
  return out;
}

/** A history entry as returned by the API (diff + reconstructed snapshot). */
export interface HistoryEntry {
  version: number;
  changedFields: ChangedFields;
  actorId: string | null;
  reason: string | null;
  createdAt: string;
  snapshot: RequirementSnapshot;
}

/**
 * Build full {@link HistoryEntry} objects (newest first) from the current
 * snapshot and all version rows.
 */
export function buildHistoryEntries(
  current: RequirementSnapshot,
  versionsDesc: VersionRow[],
): HistoryEntry[] {
  const snapshots = reconstructSnapshots(current, versionsDesc);
  return versionsDesc.map((row) => ({
    version: row.version,
    changedFields: parseChangedFields(row.changedFields),
    actorId: row.actorId ?? null,
    reason: row.reason ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    snapshot: snapshots.get(row.version) ?? { ...current },
  }));
}

/**
 * Where {@link originalVersionOf} got its snapshot from (#1130):
 * - `reversed` — rebuilt by reversing every recorded change from the current row.
 * - `current`  — no change was recorded, so this IS the current row.
 */
export type OriginalSource = "reversed" | "current";

/** The requirement before its first recorded change, and how that was derived. */
export interface OriginalVersion {
  version: number;
  snapshot: RequirementSnapshot;
  source: OriginalSource;
}

/**
 * Issue #1130 — the requirement as it was before its first recorded change.
 *
 * A version row is written only when a requirement is edited through
 * {@link updateRequirementWithHistory}, so a freshly promoted, never-edited set
 * has none, and a review pinned at its version (v0) found no history entry:
 * every card read "No version history for v0" and the reviewer could not see
 * what they were asked to approve. The history replay already arrives at the
 * earliest recorded state — reversing every recorded change from the current
 * row — and simply discarded it. This returns it under the version it held:
 * one below the earliest row, or the current version when there are no rows.
 *
 * With no rows at all the snapshot is simply the current row, so `source`
 * says which it is and callers must not present `current` as pinned text.
 * Since #1162 every writer of a tracked field goes through
 * {@link updateRequirementWithHistory} (a guard test enforces it), but a
 * requirement written before that fix may still carry an unrecorded change,
 * which reversing recorded changes cannot undo.
 *
 * Chosen over writing a v0 row at promotion: it needs no migration or backfill,
 * so it also covers every review requested before this change.
 */
export function originalVersionOf(
  current: RequirementSnapshot,
  currentVersion: number,
  versionsDesc: VersionRow[],
): OriginalVersion {
  let running: RequirementSnapshot = { ...current };
  for (const row of versionsDesc)
    running = applyReverse(running, parseChangedFields(row.changedFields));
  const earliest = versionsDesc.at(-1);
  return earliest
    ? { version: earliest.version - 1, snapshot: running, source: "reversed" }
    : { version: currentVersion, snapshot: running, source: "current" };
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

const TRACKED_SELECT = {
  id: true,
  version: true,
  title: true,
  body: true,
  priority: true,
  type: true,
  labels: true,
  storyPoints: true,
  acceptanceCriteria: true,
} as const;

/** {@link TRACKED_SELECT} plus the untracked columns an update may also write. */
const UPDATE_SELECT = {
  ...TRACKED_SELECT,
  reviewStatus: true,
  externalUrl: true,
  importSourceId: true,
} as const;

export interface UpdateWithHistoryParams {
  requirementId: string;
  /** Patch of tracked fields. `labels` must already be a JSON string. */
  patch: Partial<RequirementSnapshot>;
  /**
   * #1162 — untracked columns to write in the same transaction (and the same
   * conditional write) as the patch. Recorded in no version row; an
   * untracked-only change leaves `version` alone. Only changed values are
   * written, and reported back as {@link UpdateWithHistoryResult.untrackedChanges}.
   */
  untrackedData?: UntrackedRequirementData;
  actorId?: string | null;
  reason?: string | null;
  /**
   * Issue #1118 — owning project the caller is authorized for. When set, the
   * requirement lookup is narrowed to it, so a requirement outside the caller's
   * tenant is NOT_FOUND at the service layer as well as at the router guard.
   * `undefined` means "no narrowing" (system admins).
   */
  projectId?: string;
  /**
   * #865 — owning analysis, for the analysis-scoped route
   * (`PATCH /api/analyses/:id/requirements/:reqId`). When set, a requirement of
   * another analysis is NOT_FOUND, so that route cannot write cross-analysis.
   */
  analysisId?: string;
  /**
   * #871 — the version the caller's edit was based on (the request body's
   * `version`). Compared INSIDE the write transaction, so two concurrent edits
   * carrying the same version cannot both succeed: the loser gets
   * `VERSION_CONFLICT`. `undefined` opts out of optimistic locking (last writer
   * wins), matching the route's "no `version` skips the check" contract.
   */
  expectedVersion?: number;
  /**
   * Issue #940 — treat `patch.labels` as the caller's VISIBLE labels: merge
   * them onto the hidden `finding:*` / `review:*` labels of the row read in
   * this transaction instead of replacing the list. For callers that, like the
   * requirement Edit dialog, never see the hidden labels.
   */
  keepHiddenLabels?: boolean;
}

/**
 * How many times an UNVERSIONED write (an edit with no `expectedVersion`, or a
 * restore) re-reads and retries after losing the conditional write to a
 * concurrent edit. Each retry re-applies its change on top of the winner's row,
 * so it is last-writer-wins with a correct, gap-free version history.
 */
const UNVERSIONED_WRITE_ATTEMPTS = 3;

/**
 * Run `attempt` until it stops losing the conditional write, at most
 * {@link UNVERSIONED_WRITE_ATTEMPTS} times. Only a lost race is retried, and
 * only when `retryOnConflict` — a versioned caller's conflict is its own to
 * resolve.
 */
async function retryLostRace<T>(retryOnConflict: boolean, attempt: () => Promise<T>): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      const lostRace = err instanceof RequirementVersionError && err.code === "VERSION_CONFLICT";
      if (!lostRace || !retryOnConflict || n >= UNVERSIONED_WRITE_ATTEMPTS) throw err;
    }
  }
}

export interface UpdateWithHistoryResult {
  id: string;
  version: number;
  updatedAt: Date;
  changed: boolean;
  changedFields: ChangedFields;
  /** #1162 — the untracked columns this call actually changed (never versioned). */
  untrackedChanges: ChangedFields;
}

/**
 * #1162 — refuse a write that would put a column past the history: a
 * non-tracked key in `patch` would be written with no version row, and a
 * tracked key in `untrackedData` would be written as if it were untracked.
 * Both are programming errors, so they throw rather than being dropped.
 */
function assertWritableKeys(params: UpdateWithHistoryParams): void {
  for (const key of Object.keys(params.patch)) {
    if (!(TRACKED_FIELDS as readonly string[]).includes(key)) {
      throw new TypeError(
        `"${key}" is not a tracked field; pass it as untrackedData so it is written deliberately`,
      );
    }
  }
  for (const key of Object.keys(params.untrackedData ?? {})) {
    if (!(UNTRACKED_WRITABLE_FIELDS as readonly string[]).includes(key)) {
      throw new TypeError(`"${key}" cannot be written as untracked data`);
    }
  }
}

/**
 * Update a requirement's tracked fields and, when something actually changed,
 * append an immutable version row in the SAME transaction. The new version
 * number is `existing.version + 1`. No-op patches leave the version untouched
 * and append no row.
 */
export async function updateRequirementWithHistory(
  client: VersionPrismaClient,
  params: UpdateWithHistoryParams,
): Promise<UpdateWithHistoryResult> {
  assertWritableKeys(params);
  // A versioned edit that lost the race is the caller's conflict to resolve;
  // an unversioned one asked for last-writer-wins, so retry on the new row.
  return retryLostRace(params.expectedVersion === undefined, () => updateOnce(client, params));
}

/**
 * One attempt of {@link updateRequirementWithHistory}.
 *
 * #871 — the version check lives here, inside the transaction, and the write
 * itself is conditional on the version read (`updateMany` WHERE `version` =
 * read version, which must match exactly one row). The in-transaction compare
 * alone is not enough on Postgres: under READ COMMITTED two transactions can
 * both read version N before either writes. The conditional UPDATE closes that
 * window on both backends — on Postgres the second UPDATE blocks on the row
 * lock and re-evaluates its WHERE against the committed row (version N+1), so
 * it matches nothing; on SQLite the driver adapter serializes transactions, so
 * the second one reads N+1 and fails the compare.
 */
async function updateOnce(
  client: VersionPrismaClient,
  params: UpdateWithHistoryParams,
): Promise<UpdateWithHistoryResult> {
  return client.$transaction(async (tx) => {
    const txc = tx as unknown as VersionPrismaClient;
    const existing = (await txc.requirement.findUnique({
      where: {
        id: params.requirementId,
        deletedAt: null,
        ...(params.projectId ? { projectId: params.projectId } : {}),
        ...(params.analysisId ? { analysisId: params.analysisId } : {}),
      },
      select: UPDATE_SELECT,
    })) as (RequirementSnapshot & { id: string; version: number } & Record<string, unknown>) | null;

    if (!existing) {
      throw new RequirementVersionError("NOT_FOUND", "Requirement not found");
    }
    if (params.expectedVersion !== undefined && existing.version !== params.expectedVersion) {
      throw versionConflict();
    }

    const before = pickTracked(existing);
    const patch: Partial<RequirementSnapshot> = { ...params.patch };
    if (params.keepHiddenLabels && typeof patch.labels === "string") {
      patch.labels = JSON.stringify(
        mergeHiddenRequirementLabels(
          parseRequirementLabels(patch.labels),
          parseRequirementLabels(typeof existing.labels === "string" ? existing.labels : null),
        ),
      );
    }
    // #1000 — editing the criteria answers the "check the acceptance criteria"
    // flag clarification answers put in the body, so the flag goes with it.
    if (
      patch.acceptanceCriteria !== undefined &&
      patch.acceptanceCriteria !== before.acceptanceCriteria
    ) {
      const body = typeof patch.body === "string" ? patch.body : before.body;
      if (typeof body === "string" && hasCriteriaFlag(body)) patch.body = clearCriteriaFlag(body);
    }
    const after: Partial<RequirementSnapshot> = { ...before, ...patch };
    const changedFields = computeChangedFields(before, after);
    const changed = Object.keys(changedFields).length > 0;
    const nextVersion = existing.version + 1;

    const untrackedChanges: ChangedFields = {};
    const untrackedWrite: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(params.untrackedData ?? {})) {
      const from = nullish(existing[field]);
      if (valuesEqual(from, value)) continue;
      untrackedChanges[field] = { from, to: nullish(value) };
      untrackedWrite[field] = value;
    }

    // #877 — a no-op writes nothing and appends no history. The version check
    // above already ran in this transaction, so there is no race to lose; and
    // an empty conditional UPDATE matches no row on a real database (Prisma
    // issues no statement for an empty `data`), which the count check below
    // would misread as a lost race.
    if (changed) {
      const { count } = await txc.requirement.updateMany({
        where: { id: params.requirementId, version: existing.version, deletedAt: null },
        data: { ...patch, ...untrackedWrite, version: nextVersion },
      });
      if (count !== 1) throw versionConflict();

      await txc.requirementVersion.create({
        data: {
          requirementId: params.requirementId,
          version: nextVersion,
          changedFields: serializeChangedFields(changedFields),
          actorId: params.actorId ?? null,
          reason: params.reason ?? null,
        },
      });
    } else if (Object.keys(untrackedWrite).length > 0) {
      // #1162 — an untracked-only change: the same conditional write, no version.
      const { count } = await txc.requirement.updateMany({
        where: { id: params.requirementId, version: existing.version, deletedAt: null },
        data: untrackedWrite,
      });
      if (count !== 1) throw versionConflict();
    }

    const updated = (await txc.requirement.findUnique({
      where: { id: params.requirementId },
      select: { id: true, version: true, updatedAt: true },
    })) as { id: string; version: number; updatedAt: Date };

    return {
      id: updated.id,
      version: updated.version,
      updatedAt: updated.updatedAt,
      changed,
      changedFields,
      untrackedChanges,
    };
  });
}

function versionConflict(): RequirementVersionError {
  return new RequirementVersionError(
    "VERSION_CONFLICT",
    "Requirement has been modified since you loaded it",
  );
}

export interface RestoreParams {
  requirementId: string;
  /** The historical version number to restore to (must be an existing row). */
  targetVersion: number;
  actorId?: string | null;
  reason?: string | null;
  /** Issue #1118 — see {@link UpdateWithHistoryParams.projectId}. */
  projectId?: string;
}

export interface RestoreResult {
  id: string;
  version: number;
  updatedAt: Date;
  restoredFrom: number;
  changedFields: ChangedFields;
}

/**
 * Restore a requirement to the state captured at `targetVersion`. Reconstructs
 * the snapshot by rolling back every version newer than the target, writes the
 * reverted fields, and appends a NEW version row (N+1). History is never
 * mutated or deleted.
 *
 * #871 — restore takes no expected version (the route has none to give: the
 * target is a history row, not the version the caller loaded), so it is
 * last-writer-wins like an unversioned edit. Its write is still conditional on
 * the version it read: a concurrent edit that commits in between makes the
 * write match nothing, and the restore re-reads and recomputes the target state
 * on top of the winner's row, rather than writing a snapshot diffed against a
 * stale row under a version number the winner already used.
 */
export async function restoreRequirementVersion(
  client: VersionPrismaClient,
  params: RestoreParams,
): Promise<RestoreResult> {
  return retryLostRace(true, () => restoreOnce(client, params));
}

/** One attempt of {@link restoreRequirementVersion}. */
async function restoreOnce(
  client: VersionPrismaClient,
  params: RestoreParams,
): Promise<RestoreResult> {
  return client.$transaction(async (tx) => {
    const txc = tx as unknown as VersionPrismaClient;
    const existing = (await txc.requirement.findUnique({
      where: {
        id: params.requirementId,
        deletedAt: null,
        ...(params.projectId ? { projectId: params.projectId } : {}),
      },
      select: TRACKED_SELECT,
    })) as (RequirementSnapshot & { id: string; version: number }) | null;

    if (!existing) {
      throw new RequirementVersionError("NOT_FOUND", "Requirement not found");
    }

    const rows = (await txc.requirementVersion.findMany({
      where: { requirementId: params.requirementId },
      orderBy: { version: "desc" },
    })) as unknown as VersionRow[];

    if (!rows.some((r) => r.version === params.targetVersion)) {
      throw new RequirementVersionError(
        "INVALID_VERSION",
        `Version ${params.targetVersion} does not exist for this requirement`,
      );
    }

    // Roll backward from current state through every version newer than target.
    let state = pickTracked(existing);
    for (const row of rows) {
      if (row.version > params.targetVersion) {
        state = applyReverse(state, parseChangedFields(row.changedFields));
      }
    }

    const before = pickTracked(existing);
    const changedFields = computeChangedFields(before, state);
    const nextVersion = existing.version + 1;

    const { count } = await txc.requirement.updateMany({
      where: { id: params.requirementId, version: existing.version, deletedAt: null },
      data: { ...state, version: nextVersion },
    });
    if (count !== 1) throw versionConflict();

    await txc.requirementVersion.create({
      data: {
        requirementId: params.requirementId,
        version: nextVersion,
        changedFields: serializeChangedFields(changedFields),
        actorId: params.actorId ?? null,
        reason: params.reason ?? `Restored to version ${params.targetVersion}`,
      },
    });

    const updated = (await txc.requirement.findUnique({
      where: { id: params.requirementId },
      select: { id: true, version: true, updatedAt: true },
    })) as { id: string; version: number; updatedAt: Date };

    return {
      id: updated.id,
      version: updated.version,
      updatedAt: updated.updatedAt,
      restoredFrom: params.targetVersion,
      changedFields,
    };
  });
}
