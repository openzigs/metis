/**
 * Issue #780 — a path forward when a re-synthesis is withheld.
 *
 * #769 refuses to replace a requirement set that carries review work (or a
 * healthy set with a degraded one), because a replacement hard-deletes every
 * row. Before #780 the refused result was thrown away, so the analyst read a
 * warning and could do nothing with it. Now the refused rows are kept on the
 * analysis ({@link WITHHELD_PROPOSAL_KEY}) so the analyst can compare them with
 * the current set and apply or dismiss them.
 *
 * Applying never destroys review work: a reviewed requirement the new result
 * restates differently is UPDATED through version history (its status, links,
 * comments, mappings and baseline pins stay), one it leaves out is KEPT, and a
 * requirement someone deleted is never restored. Only rows with no review work
 * are replaced, as an ordinary re-run would.
 *
 * Pure: no database access. The reader and writer are
 * `withheld-replacement-service.ts` and `replaceRequirementSet`.
 */
import {
  parseAcceptanceCriteria,
  type SynthesisDegradation,
  type WithheldReplacementDiff,
  type WithheldReplacementEntry,
  type WithheldReplacementFieldChange,
  type RequirementReplacementWithheld,
} from "@metis/shared";
import { createHash } from "node:crypto";
import { normalizeCriterion } from "./approved-criteria-carry-over.js";
import type { AmbiguousPromotionMatch, SharedPromotionMatch } from "./approved-requirement-set.js";

/** Analysis-metadata key of the stored {@link WithheldProposal}. */
export const WITHHELD_PROPOSAL_KEY = "withheldReplacementProposal";

/** History reason of the version an applied change writes on a reviewed requirement. */
export const APPLIED_WITHHELD_REPLACEMENT_REASON =
  "Applied a re-synthesis that had been withheld to protect review work";

/**
 * One requirement row the refused re-synthesis would have inserted, as the
 * insert would have written it (minus the analysis and project ids).
 */
export interface WithheldProposalRow {
  type: string;
  title: string;
  body: string;
  priority: string;
  /** JSON array, as the `labels` column stores it. */
  labels: string;
  /** JSON array, as the `acceptanceCriteria` column stores it. */
  acceptanceCriteria: string;
  storyPoints: number | null;
  coverage: string | null;
  verdict: string | null;
  sourceCandidateIds: string | null;
  promotedStructuredId?: string;
  promotedStructuredRunId?: string | null;
  promotedSynthesisKeys?: string;
}

/** The refused result, stored with the refusal it belongs to. */
export interface WithheldProposal {
  /** The `at` of the {@link RequirementReplacementWithheld} it belongs to. */
  at: string;
  rows: WithheldProposalRow[];
  /**
   * The refused synthesis's health; applied with the rows. Absent when the
   * caller did not know it (the #1104 promotion path): applying then leaves
   * the set's degradation marker as it is, as a replacement does.
   */
  degraded?: SynthesisDegradation | null;
  /**
   * #723 / #909 — the promotion the refused write would have recorded: the
   * extraction run and the approved structured ids (possibly none). Present
   * only when the rows came from the approval checkpoint (`promotedFrom`).
   */
  promotion?: { runId: string | null; structuredIds: string[] };
  /**
   * #1203 / #1204 — the promotion's matching notes, index-aligned with `rows`
   * through `approvedIndex`, so applying records them for the rows it writes.
   */
  matches?: { ambiguous: AmbiguousPromotionMatch[]; shared: SharedPromotionMatch[] };
  /** The status the rows would have been inserted with (#939). */
  reviewStatus?: "approved";
}

const isString = (v: unknown): v is string => typeof v === "string";

function readRow(raw: unknown): WithheldProposalRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (![r.type, r.title, r.body, r.priority, r.labels, r.acceptanceCriteria].every(isString)) {
    return null;
  }
  const row: WithheldProposalRow = {
    type: r.type as string,
    title: r.title as string,
    body: r.body as string,
    priority: r.priority as string,
    labels: r.labels as string,
    acceptanceCriteria: r.acceptanceCriteria as string,
    storyPoints: typeof r.storyPoints === "number" ? r.storyPoints : null,
    coverage: isString(r.coverage) ? r.coverage : null,
    verdict: isString(r.verdict) ? r.verdict : null,
    sourceCandidateIds: isString(r.sourceCandidateIds) ? r.sourceCandidateIds : null,
  };
  if (isString(r.promotedStructuredId)) {
    row.promotedStructuredId = r.promotedStructuredId;
    row.promotedStructuredRunId = isString(r.promotedStructuredRunId)
      ? r.promotedStructuredRunId
      : null;
    if (isString(r.promotedSynthesisKeys)) row.promotedSynthesisKeys = r.promotedSynthesisKeys;
  }
  return row;
}

/** The stored proposal, or null when there is none or it is malformed. */
export function readWithheldProposal(metadata: Record<string, unknown>): WithheldProposal | null {
  const raw = metadata[WITHHELD_PROPOSAL_KEY];
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (!isString(p.at) || !Array.isArray(p.rows)) return null;
  const rows: WithheldProposalRow[] = [];
  for (const r of p.rows) {
    const row = readRow(r);
    if (!row) return null;
    rows.push(row);
  }
  const degraded =
    p.degraded && typeof p.degraded === "object"
      ? (p.degraded as SynthesisDegradation)
      : p.degraded === null
        ? null
        : undefined;
  return {
    at: p.at,
    rows,
    ...(degraded !== undefined ? { degraded } : {}),
    ...readPromotion(p.promotion),
    ...readMatches(p.matches),
    ...(p.reviewStatus === "approved" ? { reviewStatus: "approved" as const } : {}),
  };
}

function readPromotion(raw: unknown): Pick<WithheldProposal, "promotion"> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as { runId?: unknown; structuredIds?: unknown };
  if (!Array.isArray(r.structuredIds) || !r.structuredIds.every(isString)) return {};
  return {
    promotion: {
      runId: isString(r.runId) ? r.runId : null,
      structuredIds: r.structuredIds as string[],
    },
  };
}

const hasApprovedIndex = (v: unknown): boolean =>
  !!v &&
  typeof v === "object" &&
  typeof (v as { approvedIndex?: unknown }).approvedIndex === "number";

function readMatches(raw: unknown): Pick<WithheldProposal, "matches"> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as { ambiguous?: unknown; shared?: unknown };
  const ambiguous = Array.isArray(r.ambiguous) ? r.ambiguous.filter(hasApprovedIndex) : [];
  const shared = Array.isArray(r.shared) ? r.shared.filter(hasApprovedIndex) : [];
  if (ambiguous.length === 0 && shared.length === 0) return {};
  return {
    matches: {
      ambiguous: ambiguous as AmbiguousPromotionMatch[],
      shared: shared as SharedPromotionMatch[],
    },
  };
}

/** The refusal record in analysis metadata, or null. */
export function readWithheldRecord(
  metadata: Record<string, unknown>,
): RequirementReplacementWithheld | null {
  const raw = metadata.requirementReplacementWithheld;
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Partial<RequirementReplacementWithheld>;
  if (!isString(w.at) || (w.reason !== "reviewed-work" && w.reason !== "degraded-synthesis")) {
    return null;
  }
  return raw as RequirementReplacementWithheld;
}

/** A current requirement row as the comparison needs it. */
export interface CurrentRequirementRow {
  id: string;
  /** The optimistic-lock version (#871): bumped by every content edit. */
  version: number;
  type: string;
  title: string;
  body: string;
  priority: string;
  acceptanceCriteria: string | null;
  reviewStatus: string | null;
  /** Carries review work (#769's definition). */
  reviewed: boolean;
  /** Someone deleted it (`deletedAt` set). */
  deleted: boolean;
  promotedStructuredId: string | null;
  promotedStructuredRunId: string | null;
}

/** A title as two runs are compared on: case, punctuation and spacing ignored. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pair each proposed row with the current requirement it restates: first by
 * the structured requirement both were promoted from (#1202), then by title.
 * Live rows are tried before deleted ones, and each row is used once.
 * Returns proposed index → current row (absent when it is new).
 */
export function matchWithheldProposal(
  current: readonly CurrentRequirementRow[],
  proposed: readonly WithheldProposalRow[],
): Map<number, CurrentRequirementRow> {
  const out = new Map<number, CurrentRequirementRow>();
  const used = new Set<string>();
  const ordered = [...current.filter((r) => !r.deleted), ...current.filter((r) => r.deleted)];
  proposed.forEach((p, i) => {
    if (!p.promotedStructuredId) return;
    const hit = ordered.find(
      (c) =>
        !used.has(c.id) &&
        c.promotedStructuredId === p.promotedStructuredId &&
        (c.promotedStructuredRunId ?? null) === (p.promotedStructuredRunId ?? null),
    );
    if (hit) {
      out.set(i, hit);
      used.add(hit.id);
    }
  });
  proposed.forEach((p, i) => {
    if (out.has(i)) return;
    const key = normalizeTitle(p.title);
    const hit = ordered.find((c) => !used.has(c.id) && normalizeTitle(c.title) === key);
    if (hit) {
      out.set(i, hit);
      used.add(hit.id);
    }
  });
  return out;
}

function sameCriteria(a: readonly string[], b: readonly string[]): boolean {
  const na = a.map(normalizeCriterion).sort();
  const nb = b.map(normalizeCriterion).sort();
  return na.length === nb.length && na.every((x, i) => x === nb[i]);
}

/** The fields a proposed row changes on the current requirement it restates. */
export function fieldChanges(
  current: Pick<
    CurrentRequirementRow,
    "title" | "body" | "priority" | "type" | "acceptanceCriteria"
  >,
  proposed: WithheldProposalRow,
): WithheldReplacementFieldChange[] {
  const changes: WithheldReplacementFieldChange[] = [];
  const text = (
    field: WithheldReplacementFieldChange["field"],
    before: string,
    after: string,
  ): void => {
    if (before.trim() !== after.trim()) changes.push({ field, before, after });
  };
  text("title", current.title, proposed.title);
  text("description", current.body, proposed.body);
  text("priority", current.priority, proposed.priority);
  text("type", current.type, proposed.type);
  const before = parseAcceptanceCriteria(current.acceptanceCriteria);
  const after = parseAcceptanceCriteria(proposed.acceptanceCriteria);
  // A re-synthesis that gave no criteria leaves the current ones in place
  // (#1389's incident shape), so it is not a change to apply.
  if (after.length > 0 && !sameCriteria(before, after)) {
    changes.push({ field: "acceptanceCriteria", before, after });
  }
  return changes;
}

/** One planned step of applying a proposal. */
export type WithheldApplyStep =
  /** A proposed requirement with no current counterpart: inserted. */
  | { kind: "insert"; proposed: WithheldProposalRow }
  /** An unreviewed requirement the proposal restates: deleted, its restatement inserted. */
  | {
      kind: "replace";
      current: CurrentRequirementRow;
      proposed: WithheldProposalRow;
      changed: boolean;
    }
  /** A reviewed requirement the proposal restates: updated through version history. */
  | { kind: "update"; current: CurrentRequirementRow; proposed: WithheldProposalRow }
  /** An unreviewed requirement the proposal leaves out: deleted. */
  | { kind: "delete"; current: CurrentRequirementRow }
  /** A reviewed requirement the proposal leaves out: kept. */
  | { kind: "keep"; current: CurrentRequirementRow };

/**
 * What applying `proposal` to `current` does. Rows with no review work are
 * replaced by their restatement or deleted, as a re-run would; reviewed rows
 * are updated in place or kept; deleted rows stay deleted and their
 * restatement is not inserted.
 */
export function planWithheldApply(
  current: readonly CurrentRequirementRow[],
  proposed: readonly WithheldProposalRow[],
): WithheldApplyStep[] {
  const matches = matchWithheldProposal(current, proposed);
  const steps: WithheldApplyStep[] = [];
  const matchedIds = new Set([...matches.values()].map((c) => c.id));
  for (const c of current) {
    if (c.deleted || matchedIds.has(c.id)) continue;
    steps.push(c.reviewed ? { kind: "keep", current: c } : { kind: "delete", current: c });
  }
  proposed.forEach((p, i) => {
    const c = matches.get(i);
    if (!c) steps.push({ kind: "insert", proposed: p });
    else if (c.deleted) return;
    else if (c.reviewed) steps.push({ kind: "update", current: c, proposed: p });
    else {
      steps.push({
        kind: "replace",
        current: c,
        proposed: p,
        changed: fieldChanges(c, p).length > 0,
      });
    }
  });
  return steps;
}

/**
 * Issue #780 — what the analyst confirmed. A digest of every planned step:
 * which requirement, at which version, what happens to it and which fields
 * change. The comparison returns it and Apply recomputes it under the lock:
 * a requirement edited, or one that gained review work, between Review and
 * Apply changes the digest, so Apply refuses instead of writing something the
 * confirmation did not show.
 */
export function fingerprintWithheldPlan(steps: readonly WithheldApplyStep[]): string {
  const parts = steps.map((s) => {
    const fields =
      s.kind === "update" || s.kind === "replace"
        ? fieldChanges(s.current, s.proposed).map((c) => c.field)
        : [];
    return JSON.stringify([
      s.kind,
      "current" in s ? s.current.id : null,
      "current" in s ? s.current.version : null,
      "proposed" in s ? s.proposed.title : null,
      fields,
    ]);
  });
  return createHash("sha256").update(parts.sort().join("\n")).digest("hex").slice(0, 32);
}

/** The analyst-facing comparison of `current` with the withheld `proposal`. */
export function diffWithheldReplacement(
  withheld: RequirementReplacementWithheld,
  current: readonly CurrentRequirementRow[],
  proposed: readonly WithheldProposalRow[],
): WithheldReplacementDiff {
  const matches = matchWithheldProposal(current, proposed);
  const matchedIds = new Set([...matches.values()].map((c) => c.id));
  const diff: WithheldReplacementDiff = {
    withheld,
    fingerprint: fingerprintWithheldPlan(planWithheldApply(current, proposed)),
    added: [],
    changed: [],
    removed: [],
    skipped: [],
    unchangedCount: 0,
  };
  const entry = (
    c: CurrentRequirementRow,
    outcome: WithheldReplacementEntry["outcome"],
    changes: WithheldReplacementFieldChange[] = [],
  ): WithheldReplacementEntry => ({
    title: c.title,
    outcome,
    reviewed: c.reviewed,
    reviewStatus: c.reviewStatus,
    changes,
  });
  proposed.forEach((p, i) => {
    const c = matches.get(i);
    if (!c) {
      diff.added.push({
        title: p.title,
        outcome: "add",
        reviewed: false,
        reviewStatus: null,
        changes: [],
        proposed: {
          type: p.type,
          priority: p.priority,
          description: p.body,
          acceptanceCriteria: parseAcceptanceCriteria(p.acceptanceCriteria),
        },
      });
      return;
    }
    if (c.deleted) {
      diff.skipped.push(entry(c, "skip"));
      return;
    }
    const changes = fieldChanges(c, p);
    if (changes.length === 0) diff.unchangedCount++;
    else diff.changed.push(entry(c, c.reviewed ? "update" : "replace", changes));
  });
  for (const c of current) {
    if (c.deleted || matchedIds.has(c.id)) continue;
    diff.removed.push(entry(c, c.reviewed ? "keep" : "delete"));
  }
  return diff;
}
