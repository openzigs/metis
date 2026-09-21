/**
 * Diff-style current-vs-proposed aggregator — PURE builder (Issue #743, Epic #728).
 *
 * Assembles, for every requirement that CHANGED between a base ("current") and a
 * head ("proposed") analysis run, a side-by-side entry:
 *
 *   - `current`  — the base requirement + its code-grounded evidence (the base
 *     run's gap-report `currentImplementation.citations`, #742/#734). Present for
 *     `modified` and `removed`.
 *   - `proposed` — the head requirement text + the head run's gap report (what
 *     would change / the remaining gap). Present for `modified` and `added`.
 *
 * COMPOSITION, NOT REIMPLEMENTATION. All requirement diffing is delegated to the
 * Change Analysis engine's already-exported, side-effect-free primitives:
 *
 *   - `matchRequirements`   — title-similarity matching → matched/added/removed.
 *   - `computeSeverity`     — change severity from type + content delta.
 *   - `computeImpactScore`  — impact score from type/severity/hierarchy/delta.
 *   - `generateDiffSummary` — human-readable modification summary.
 *
 * This module adds NO new diffing, similarity, or scoring logic; it only maps the
 * engine's output onto the current-vs-proposed shape and attaches the #742 gap
 * reports. `change-analysis-engine.ts` is imported read-only and left unmodified.
 */
import {
  REQUIREMENT_PRIORITIES,
  type CodeCitation,
  type GapReport,
  type GapReportRequirement,
  type RequirementDiff,
  type RequirementDiffCurrent,
  type RequirementDiffEntry,
  type RequirementDiffProposed,
  type RequirementPriority,
} from "@metis/shared";
import {
  matchRequirements,
  computeSeverity,
  computeImpactScore,
  generateDiffSummary,
} from "./change-analysis-engine.js";

const PRIORITY_SET = new Set<string>(REQUIREMENT_PRIORITIES);

/** Coerce the engine's widened `priority: string` back to the shared union. */
function coercePriority(value: string): RequirementPriority {
  return PRIORITY_SET.has(value) ? (value as RequirementPriority) : "medium";
}

/**
 * The requirement shape the engine's matcher hands back — same fields as
 * {@link RequirementDiffRequirementInput} but with the widened `priority: string`.
 */
interface EngineRequirement {
  id: string;
  title: string;
  body: string;
  type: string;
  priority: string;
  labels: string;
  storyPoints: number | null;
  parentId: string | null;
}

/**
 * Minimal requirement projection the aggregator needs — structurally the same
 * shape the engine's `matchRequirements` consumes (id/title/body/type/priority/
 * labels/storyPoints/parentId), so it can be passed straight through.
 */
export interface RequirementDiffRequirementInput {
  id: string;
  title: string;
  body: string;
  type: string;
  priority: RequirementPriority;
  labels: string;
  storyPoints: number | null;
  parentId: string | null;
}

/** One run's inputs to the diff: its requirements + its per-requirement gap report. */
export interface RequirementDiffRunInput {
  requirements: RequirementDiffRequirementInput[];
  /** The run's #742 gap report (indexed by requirementId), or null if absent. */
  gapReport: GapReport | null;
}

export interface BuildRequirementDiffInput {
  projectId: string;
  headAnalysisId: string;
  /** Null ⇒ no base run to compare against ⇒ empty diff (explicit empty state). */
  baseAnalysisId: string | null;
  base: RequirementDiffRunInput | null;
  head: RequirementDiffRunInput;
}

function emptyDiff(input: BuildRequirementDiffInput): RequirementDiff {
  return {
    projectId: input.projectId,
    headAnalysisId: input.headAnalysisId,
    baseAnalysisId: input.baseAnalysisId,
    entries: [],
    summary: { total: 0, added: 0, removed: 0, modified: 0 },
  };
}

/** Index a gap report by requirementId for O(1) side lookups. */
function indexGapReport(report: GapReport | null): Map<string, GapReportRequirement> {
  const map = new Map<string, GapReportRequirement>();
  if (!report) return map;
  for (const r of report.requirements) map.set(r.requirementId, r);
  return map;
}

function toCurrent(
  req: EngineRequirement,
  gapByReqId: Map<string, GapReportRequirement>,
): RequirementDiffCurrent {
  const gap = gapByReqId.get(req.id);
  const codeCitations: CodeCitation[] = gap?.currentImplementation.citations ?? [];
  return {
    requirementId: req.id,
    title: req.title,
    body: req.body,
    priority: coercePriority(req.priority),
    storyPoints: req.storyPoints,
    codeCitations,
    hasEvidence: codeCitations.length > 0,
  };
}

function toProposed(
  req: EngineRequirement,
  gapByReqId: Map<string, GapReportRequirement>,
): RequirementDiffProposed {
  return {
    requirementId: req.id,
    title: req.title,
    body: req.body,
    priority: coercePriority(req.priority),
    storyPoints: req.storyPoints,
    gapReport: gapByReqId.get(req.id) ?? null,
  };
}

/**
 * True when a matched base/head pair is materially unchanged — mirrors the engine's
 * own skip condition so `modified` entries agree with a real change analysis. This
 * is a plain field-equality filter, NOT requirement matching (that stays in the
 * engine's `matchRequirements`).
 */
function isUnchanged(base: EngineRequirement, head: EngineRequirement): boolean {
  return (
    base.title === head.title &&
    base.body === head.body &&
    base.type === head.type &&
    base.priority === head.priority &&
    base.storyPoints === head.storyPoints
  );
}

export function buildRequirementDiff(input: BuildRequirementDiffInput): RequirementDiff {
  // No base to compare against ⇒ explicit empty state (not "everything added").
  if (!input.base || input.baseAnalysisId == null) {
    return emptyDiff(input);
  }

  const baseReqs = input.base.requirements;
  const headReqs = input.head.requirements;

  // Delegate ALL diffing to the engine's exported matcher.
  const { matched, removed, added } = matchRequirements(baseReqs, headReqs);

  // Parent lookups for the engine's hierarchy-aware impact weight (same source as
  // `executeChangeAnalysis`), so scores match a real change analysis.
  const headParentIds = new Set(headReqs.filter((r) => r.parentId).map((r) => r.parentId!));
  const baseParentIds = new Set(baseReqs.filter((r) => r.parentId).map((r) => r.parentId!));

  const baseGap = indexGapReport(input.base.gapReport);
  const headGap = indexGapReport(input.head.gapReport);

  const entries: RequirementDiffEntry[] = [];

  // Modified — matched pairs that materially changed.
  for (const { base, head } of matched) {
    if (isUnchanged(base, head)) continue;
    const bodyDelta = Math.abs(head.body.length - base.body.length);
    const priorityChanged = base.priority !== head.priority;
    const typeChanged = base.type !== head.type;
    const severity = computeSeverity("modified", bodyDelta, priorityChanged, typeChanged);
    const impactScore = computeImpactScore(
      "modified",
      severity,
      headParentIds.has(head.id),
      bodyDelta,
    );
    entries.push({
      changeType: "modified",
      severity,
      impactScore,
      diffSummary: generateDiffSummary(base, head),
      current: toCurrent(base, baseGap),
      proposed: toProposed(head, headGap),
    });
  }

  // Added — present only in head (proposed, no current).
  for (const h of added) {
    const bodyDelta = h.body.length;
    const severity = computeSeverity("added", bodyDelta, false, false);
    const impactScore = computeImpactScore("added", severity, headParentIds.has(h.id), bodyDelta);
    entries.push({
      changeType: "added",
      severity,
      impactScore,
      diffSummary: `New ${h.type} requirement added`,
      current: null,
      proposed: toProposed(h, headGap),
    });
  }

  // Removed — present only in base (current, no proposed).
  for (const b of removed) {
    const bodyDelta = b.body.length;
    const severity = computeSeverity("removed", bodyDelta, false, false);
    const impactScore = computeImpactScore("removed", severity, baseParentIds.has(b.id), bodyDelta);
    entries.push({
      changeType: "removed",
      severity,
      impactScore,
      diffSummary: `${b.type} requirement removed`,
      current: toCurrent(b, baseGap),
      proposed: null,
    });
  }

  const modified = entries.filter((e) => e.changeType === "modified").length;
  const addedCount = entries.filter((e) => e.changeType === "added").length;
  const removedCount = entries.filter((e) => e.changeType === "removed").length;

  return {
    projectId: input.projectId,
    headAnalysisId: input.headAnalysisId,
    baseAnalysisId: input.baseAnalysisId,
    entries,
    summary: {
      total: entries.length,
      added: addedCount,
      removed: removedCount,
      modified,
    },
  };
}
