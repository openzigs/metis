/**
 * #2222 — which governing findings judge an older wording of a requirement.
 *
 * #2219 made an edit of an approved requirement reopen its approval, but the
 * analysis' governing findings kept judging the old wording with nothing to say
 * so. A finding row is keyed by the requirement AS THE RUN ANALYSED IT
 * (`AC-2`, the code agent's id), and the stored requirements an analyst edits
 * are not joined to it by id: each stored requirement's `finding:<id>` labels
 * name the analysis findings it was written from, and each of those records the
 * analysed requirement it was produced for (see `docs-gen/governing-section.ts`,
 * "FINDINGS ARE PER ANALYSED REQUIREMENT"). Measured on the dev sample, the
 * join is many-to-many: one analysed requirement fed three stored ones, and a
 * stored one drew on two analysed ones.
 *
 * VERSIONS. A stored requirement's ANALYSED version is the one the analysis
 * wrote: its version before the first edit by a person (a `RequirementVersion`
 * row with an actor), or its current version when no person has edited it.
 * System versions (kept approved criteria, clarification enrichment) are the
 * analysis's own writing. A finding judged on the analysed wording judged every
 * stored requirement drawn from it at that version. **Re-check this
 * requirement** (`recheck.ts`) judges one stored requirement's current wording
 * under its own id, and its rows record the version judged
 * (`governing_findings.requirementVersions`).
 *
 * STALE. A finding is stale for a stored requirement whose version is not the
 * one judged. A finding on an analysed requirement stops being stale for a
 * stored requirement re-checked at its current version: that requirement's
 * current wording has its own result, so the older one no longer stands for it.
 *
 * DELETED (#2281). A re-check stores its findings, and its applicability entry,
 * under the stored requirement's own id. Once that requirement is deleted, they
 * judge nothing a reader can see: no title names them and no version can go
 * stale. They are left out wherever findings are shown, and the clarify flow
 * asks no question about them. They are kept, not deleted, so a requirement
 * restored from its history brings them back.
 *
 * NOT YET CHECKED (#2281). A requirement edited since the check whose analysed
 * requirement produced no governing finding has no finding to go stale, so no
 * stale group offered it a re-check. {@link editedWithoutFindings} lists it.
 *
 * TENANCY. Requirements are read with the analysis AND project ids, and the
 * evidence findings with the analysis and project of their agent result, so a
 * label naming another run's finding never joins.
 */
import {
  type GoverningAnalysisApplicability,
  type GoverningFinding,
  type GoverningStaleRequirement,
} from "@metis/shared";
import { parseRequirementLabels } from "../analysis/requirement-labels.js";
import { prisma } from "../prisma.js";

type ApplicabilityEntry = GoverningAnalysisApplicability["requirements"][number];

/**
 * #2281 — whether `entry` is a re-check's: stored under a stored requirement's
 * own id, recording the version of it that was judged. An entry the analysis
 * wrote is keyed by an analysed id (`AC-2`) and records no version.
 */
export function isRecheckEntry(entry: ApplicabilityEntry): boolean {
  return entry.versions?.[entry.requirementId] !== undefined;
}

/** #2281 — the ids of the re-checked requirements of `applicability` that are not in `live`. */
export function deletedRecheckIds(
  applicability: GoverningAnalysisApplicability | null,
  live: ReadonlySet<string>,
): Set<string> {
  return new Set(
    (applicability?.requirements ?? [])
      .filter((e) => isRecheckEntry(e) && !live.has(e.requirementId))
      .map((e) => e.requirementId),
  );
}

/**
 * #2281 — `applicability` without the entries of re-checked requirements that
 * are no longer live in the analysis (see DELETED). Reads the requirements only
 * when there is a re-check entry; returns `applicability` itself when nothing
 * is left out.
 */
export async function withoutDeletedRechecks(
  applicability: GoverningAnalysisApplicability,
  analysisId: string,
  projectId: string,
): Promise<GoverningAnalysisApplicability> {
  const ids = applicability.requirements.filter(isRecheckEntry).map((e) => e.requirementId);
  if (ids.length === 0) return applicability;
  const rows = await prisma.requirement.findMany({
    where: { id: { in: ids }, analysisId, projectId, deletedAt: null },
    select: { id: true },
  });
  const deleted = deletedRecheckIds(applicability, new Set(rows.map((r) => r.id)));
  if (deleted.size === 0) return applicability;
  return {
    ...applicability,
    requirements: applicability.requirements.filter((e) => !deleted.has(e.requirementId)),
  };
}

/** One live stored requirement of an analysis, as staleness reads it. */
export interface StoredRequirementState {
  id: string;
  title: string;
  version: number;
  /** The version the analysis wrote (see VERSIONS). */
  analysedVersion: number;
  /** The analysed requirement ids (`AC-2`) its evidence findings were produced for. */
  analysedIds: ReadonlySet<string>;
}

/**
 * The analysed version of a requirement at `version` whose first version by a
 * person is `firstPersonVersion` (undefined: no person has edited it).
 */
export function analysedVersionOf(version: number, firstPersonVersion: number | undefined): number {
  return firstPersonVersion === undefined ? version : Math.max(0, firstPersonVersion - 1);
}

/**
 * The first version a person wrote, by requirement id, for those of `ids` that
 * have one. A requirement at version 0 has no history, so callers pass only the
 * ids above 0.
 */
export async function firstPersonVersions(ids: readonly string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.requirementVersion.groupBy({
    by: ["requirementId"],
    where: { requirementId: { in: [...ids] }, actorId: { not: null } },
    _min: { version: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) if (r._min.version !== null) out.set(r.requirementId, r._min.version);
  return out;
}

/** The analysed version of each of `rows`, by id. */
export async function analysedVersions(
  rows: ReadonlyArray<{ id: string; version: number }>,
): Promise<Map<string, number>> {
  const first = await firstPersonVersions(rows.filter((r) => r.version > 0).map((r) => r.id));
  return new Map(rows.map((r) => [r.id, analysedVersionOf(r.version, first.get(r.id))]));
}

/** The analysed requirement a stored analysis finding was produced for, from its evidence blob. */
export function evidenceRequirementId(evidence: string | null): string | null {
  if (!evidence) return null;
  try {
    const parsed: unknown = JSON.parse(evidence);
    const id = (parsed as { requirementId?: unknown } | null)?.requirementId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/** The `finding:<id>` evidence ids of a stored requirement's labels JSON. */
export function evidenceFindingIdsOf(labels: string): string[] {
  return parseRequirementLabels(labels)
    .filter((l) => l.startsWith("finding:"))
    .map((l) => l.slice("finding:".length));
}

/** Every live stored requirement of the analysis, with its versions and analysed ids. */
export async function storedRequirementStates(
  analysisId: string,
  projectId: string,
): Promise<StoredRequirementState[]> {
  const rows = await prisma.requirement.findMany({
    where: { analysisId, projectId, deletedAt: null },
    select: { id: true, title: true, version: true, labels: true },
  });
  if (rows.length === 0) return [];
  const evidence = new Map(rows.map((r) => [r.id, evidenceFindingIdsOf(r.labels)]));
  const findingIds = [...new Set([...evidence.values()].flat())];
  const findings =
    findingIds.length === 0
      ? []
      : await prisma.finding.findMany({
          where: { id: { in: findingIds }, agentResult: { analysisId, analysis: { projectId } } },
          select: { id: true, evidence: true },
        });
  const analysedOf = new Map(findings.map((f) => [f.id, evidenceRequirementId(f.evidence)]));
  const versions = await analysedVersions(rows);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    version: r.version,
    analysedVersion: versions.get(r.id) ?? r.version,
    analysedIds: new Set(
      (evidence.get(r.id) ?? []).flatMap((id) => {
        const analysed = analysedOf.get(id);
        return analysed ? [analysed] : [];
      }),
    ),
  }));
}

/**
 * `findings` with `stale` set (see STALE), less those of a re-checked
 * requirement that is no longer live (see DELETED). Pure: `states` are the
 * analysis's live stored requirements, `applicability` its stored applicability
 * (the re-check entries carry the versions they judged).
 */
export function withGoverningStaleness(
  findings: readonly GoverningFinding[],
  states: readonly StoredRequirementState[],
  applicability: GoverningAnalysisApplicability | null,
): GoverningFinding[] {
  const byId = new Map(states.map((s) => [s.id, s]));
  const byAnalysed = new Map<string, StoredRequirementState[]>();
  for (const s of states) {
    for (const a of s.analysedIds) byAnalysed.set(a, [...(byAnalysed.get(a) ?? []), s]);
  }
  const deleted = deletedRecheckIds(applicability, new Set(byId.keys()));
  const recheckedNow = new Set(
    (applicability?.requirements ?? [])
      .filter((e) => {
        const s = byId.get(e.requirementId);
        return !e.error && s !== undefined && e.versions?.[s.id] === s.version;
      })
      .map((e) => e.requirementId),
  );
  return findings
    .filter((f) => !deleted.has(f.requirementId))
    .map((f) => {
      const own = byId.get(f.requirementId);
      const members = own ? [own] : (byAnalysed.get(f.requirementId) ?? []);
      const stale: GoverningStaleRequirement[] = members.flatMap((s) => {
        const judged = f.requirementVersions?.[s.id] ?? s.analysedVersion;
        if (judged === s.version) return [];
        if (!own && recheckedNow.has(s.id)) return [];
        return [
          { requirementId: s.id, title: s.title, judgedVersion: judged, currentVersion: s.version },
        ];
      });
      return { ...f, stale };
    });
}

/** The titles of the stored requirements `findings` are keyed by (re-checked ones). */
export function recheckedRequirementTitles(
  findings: readonly GoverningFinding[],
  states: readonly StoredRequirementState[],
): Record<string, string> {
  const keys = new Set(findings.map((f) => f.requirementId));
  return Object.fromEntries(states.filter((s) => keys.has(s.id)).map((s) => [s.id, s.title]));
}

/**
 * #2281 — the stored requirements edited since the governing check last judged
 * them that no finding offers a re-check for (see NOT YET CHECKED): drawn from
 * an analysed requirement, or re-checked before, at a version other than the
 * one judged, with no finding of their own and none stale for them. `findings`
 * are {@link withGoverningStaleness}'s. Empty when the check never ran.
 */
export function editedWithoutFindings(
  findings: readonly GoverningFinding[],
  states: readonly StoredRequirementState[],
  applicability: GoverningAnalysisApplicability | null,
): GoverningStaleRequirement[] {
  if (!applicability) return [];
  const rechecked = new Map(
    applicability.requirements
      .filter((e) => isRecheckEntry(e) && !e.error)
      .map((e) => [e.requirementId, e.versions![e.requirementId]!] as const),
  );
  const offered = new Set<string>();
  for (const f of findings) {
    offered.add(f.requirementId);
    for (const s of f.stale ?? []) offered.add(s.requirementId);
  }
  return states.flatMap((s) => {
    if (offered.has(s.id)) return [];
    const judged = rechecked.get(s.id) ?? (s.analysedIds.size > 0 ? s.analysedVersion : null);
    if (judged === null || judged === s.version) return [];
    return [
      { requirementId: s.id, title: s.title, judgedVersion: judged, currentVersion: s.version },
    ];
  });
}
