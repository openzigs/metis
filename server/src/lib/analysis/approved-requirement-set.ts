/**
 * Issue #730 — promote the requirements the user APPROVED, not a different set.
 *
 * The approval checkpoint raises one `requirement` approval per STRUCTURED
 * requirement (`metadata.structuredRequirements`, ids like `REQ-3`), so that is
 * the list a reviewer reads, edits through clarification, and approves. The
 * promotion path, however, persisted the SYNTHESIS agent's output — a disjoint
 * set, and on a degraded run the deterministic keyword fallback, titled after
 * findings ("Could not verify: …") with no acceptance criteria. Approving 27
 * requirements produced 28 unrelated ones that then needed approving again.
 *
 * This pure module builds the set to persist from the approved structured
 * requirements. Synthesis still contributes what only it has — acceptance
 * criteria, the finding evidence that drives coverage/verdicts, labels and
 * story points — but only by joining onto an approved requirement, never by
 * adding rows nobody reviewed. The join is by the ids synthesis names (#1033),
 * then on the structured TITLE, the same containment match #1116 uses to place
 * clarification answers. Issue #1202 — a requirement whose promoted row
 * recorded the items it took is joined to exactly those, before either.
 */
import type { SynthesisOutput, SynthesizedRequirement } from "@metis/shared";
import { normalizeCriteria } from "@metis/shared";
import {
  ATTRIBUTION_THRESHOLD,
  containmentScore,
  significantTokens,
} from "./clarification-enrichment.js";
import {
  compareTiersDescending,
  matchOneToOneRefusingTies,
  type OneToOneCandidate,
} from "./one-to-one-match.js";
import { synthesisItemKey, type PairedItems, type PromotionPairing } from "./promotion-pairing.js";
import type { StructuredRequirement } from "./types/requirements.js";

const PRIORITY_BY_STRUCTURED: Record<string, SynthesizedRequirement["priority"]> = {
  "must-have": "high",
  "should-have": "medium",
  "nice-to-have": "low",
};

const MAX_TITLE = 255;
const MAX_BODY = 4096;
/** `synthesizedRequirementSchema.labels` caps the list at 16. */
const MAX_LABELS = 16;
/** `synthesizedRequirementSchema` caps evidence at 50 and criteria at 20. */
const MAX_EVIDENCE = 50;
const MAX_CRITERIA = 20;

/**
 * The synthesized requirement each approved structured requirement draws its
 * criteria and evidence from.
 *
 * Issue #1033 — by id first. Synthesis names the structured requirements each
 * of its items restates (`structuredIds`). An item may consolidate several of
 * them, and then EVERY approved requirement it names receives its criteria and
 * evidence: joining on title alone gave such an item to the best-matching
 * requirement and left the others promoted with no criteria and no code link
 * (#706 runs 6, 9). Several items naming one requirement are joined into one.
 *
 * The criteria are not split between the requirements an item names, and that
 * includes a rejected or pending one it names alongside an approved one: the
 * approved requirement receives ALL of the item's criteria, the ones written
 * for its rejected sibling among them. Splitting needs word overlap to say
 * which criterion is whose, and on the run-6 text it could not — siblings share
 * their domain words, so no criterion is ever clearly one requirement's alone,
 * and a looser rule put criteria on the wrong requirement, which reads as
 * authored where a shared one is at least the model's own grouping.
 *
 * An item that names any id of this list, or says it names none
 * (`structuredIds: []`), is never matched to another requirement by title: it
 * goes only to the approved requirements it names, and to none when it names
 * only rejected or pending ones.
 *
 * The title join is the fallback, for a requirement no item names and over the
 * items that did not say (`structuredIds` absent: output from before #1033, a
 * degraded run) or name only ids no longer in the list (a list re-extracted
 * since): one-to-one, best score first, so a guess never puts the same evidence
 * on two rows. Candidates are ranked by the #1031 tiers — the same title, then
 * the containment score, then how much of the title is in the item's title —
 * and resolved by {@link matchOneToOneRefusingTies}, the rule #1031 shares: at
 * each level a pair is taken only if it is in every maximum matching of that
 * level's candidates, so no pair is a guess; every other requirement or item
 * with a candidate there is refused and takes no weaker match; list order
 * never decides. `structured` is the whole reviewed list, whose ids are the ones an
 * item can name; it defaults to `approved`.
 *
 * Issue #1129 — exported so the ticked/added split reads the same #1063
 * `sourceIds` this join carries onto the promoted row (and so onto the
 * "Added by the analysis" badge), rather than guessing from words.
 */
export function matchSynthesized(
  approved: ReadonlyArray<JoinableRequirement>,
  synthesized: readonly SynthesizedRequirement[],
  structured: ReadonlyArray<Pick<StructuredRequirement, "id" | "synthesisItemKey">> = approved,
  paired?: PairedItems,
): Map<string, SynthesizedRequirement> {
  return matchSynthesizedReportingRefusals(approved, synthesized, structured, paired).matches;
}

/** What the join reads of a reviewed requirement. */
export type JoinableRequirement = Pick<StructuredRequirement, "id" | "title" | "synthesisItemKey">;

/**
 * Issue #1204 — a requirement the title fallback refused: the items it was
 * level on (indexes into the synthesis output), as the matcher reported them.
 */
export interface RefusedTitleMatch {
  structuredId: string;
  synthesizedIndexes: number[];
}

/**
 * {@link matchSynthesized}, also reporting each requirement the title fallback
 * refused and the items it was refused among (#1204). Nothing here is
 * re-derived: the refusals are the shared matcher's own `refusedLeftOptions`.
 */
export function matchSynthesizedReportingRefusals(
  approved: ReadonlyArray<JoinableRequirement>,
  synthesized: readonly SynthesizedRequirement[],
  structured: ReadonlyArray<Pick<StructuredRequirement, "id" | "synthesisItemKey">> = approved,
  paired?: PairedItems,
): {
  matches: Map<string, SynthesizedRequirement>;
  refused: RefusedTitleMatch[];
  /** #1202 — the item indexes each matched requirement took, for its pairing. */
  given: Map<string, number[]>;
} {
  const listIds = new Set(structured.map((r) => r.id));
  // #1202 — items a promoted row already took are that row's, never a title
  // candidate for another requirement.
  const pairedIndexes = new Set<number>();
  for (const req of approved) for (const i of paired?.get(req.id) ?? []) pairedIndexes.add(i);
  // #1569 — an item offered at the checkpoint as a requirement of its own is
  // that requirement's, joined by its key below, and never a title candidate.
  const offeredKeys = new Set(structured.flatMap((r) => r.synthesisItemKey ?? []));
  const itemKeys = offeredKeys.size > 0 ? synthesized.map((s) => synthesisItemKey(s)) : [];
  // Absent: the item did not say. `[]`: it says it restates no listed one.
  // Only ids no longer in the list (a re-extraction) count as not saying.
  const titlePool = synthesized.map(
    (s, i) =>
      !pairedIndexes.has(i) &&
      !offeredKeys.has(itemKeys[i] ?? "") &&
      (s.structuredIds === undefined ||
        (s.structuredIds.length > 0 && !s.structuredIds.some((id) => listIds.has(id)))),
  );

  const byStructuredId = new Map<string, SynthesizedRequirement>();
  const given = new Map<string, number[]>();
  // #1202 — a requirement whose row recorded its items is joined to exactly
  // those: neither the id join nor the title join is consulted for it.
  const decided = new Set<string>();
  for (const req of approved) {
    const indexes = paired?.get(req.id);
    if (!indexes) continue;
    decided.add(req.id);
    given.set(req.id, [...indexes]);
    if (indexes.length > 0) {
      byStructuredId.set(req.id, joinItems(indexes.map((i) => synthesized[i]!)));
    }
  }
  for (const req of approved) {
    if (decided.has(req.id)) continue;
    const named: number[] = [];
    synthesized.forEach((s, i) => {
      const offeredFrom =
        req.synthesisItemKey !== undefined && itemKeys[i] === req.synthesisItemKey;
      if (offeredFrom || s.structuredIds?.includes(req.id)) named.push(i);
    });
    if (named.length === 0) continue;
    byStructuredId.set(req.id, joinItems(named.map((i) => synthesized[i]!)));
    given.set(req.id, named);
  }

  const synthTokens = synthesized.map((s) => significantTokens(`${s.title} ${s.body}`));
  const synthTitleTokens = synthesized.map((s) => significantTokens(s.title));
  const synthTitleKeys = synthesized.map((s) => titleKey(s.title));
  const candidates: Array<OneToOneCandidate<string, number, number[]>> = [];
  for (const req of approved) {
    if (decided.has(req.id) || byStructuredId.has(req.id)) continue;
    const needle = significantTokens(req.title);
    const key = titleKey(req.title);
    synthTokens.forEach((tokens, synthIdx) => {
      if (!titlePool[synthIdx]) return;
      const score = containmentScore(needle, tokens);
      if (score < ATTRIBUTION_THRESHOLD) return;
      // The #1031 tiers, best first: the same title; then the containment
      // score; then how much of the title is in the item's TITLE, not its body.
      candidates.push({
        left: req.id,
        right: synthIdx,
        score: [
          synthTitleKeys[synthIdx] === key ? 1 : 0,
          score,
          containmentScore(needle, synthTitleTokens[synthIdx]!),
        ],
      });
    });
  }
  const { matches, refusedLeftOptions } = matchOneToOneRefusingTies(candidates, {
    compare: compareTiersDescending,
  });
  for (const [structuredId, synthIdx] of matches) {
    byStructuredId.set(structuredId, synthesized[synthIdx]!);
    given.set(structuredId, [synthIdx]);
  }
  // In the reviewed order, so the record reads like the list.
  const refused = approved
    .filter((r) => refusedLeftOptions.has(r.id))
    .map((r) => ({
      structuredId: r.id,
      synthesizedIndexes: [...refusedLeftOptions.get(r.id)!].sort((a, b) => a - b),
    }));
  return { matches: byStructuredId, refused, given };
}

/** Case- and whitespace-insensitive title, for the same-title tier. */
function titleKey(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Several items naming one requirement, joined: lists united in order, scalars from the first. */
function joinItems(parts: readonly SynthesizedRequirement[]): SynthesizedRequirement {
  const first = parts[0]!;
  if (parts.length === 1) return first;
  const unite = <T>(pick: (s: SynthesizedRequirement) => readonly T[] | undefined): T[] => [
    ...new Set(parts.flatMap((p) => pick(p) ?? [])),
  ];
  const sourceIds = parts.some((p) => p.sourceIds !== undefined)
    ? unite((p) => p.sourceIds)
    : undefined;
  const storyPoints = parts.find((p) => p.storyPoints !== undefined)?.storyPoints;
  // #1610 — every part's per-criterion evidence, keyed by criterion text; the
  // verdict roll-up reads only the criteria and findings the join kept.
  const criterionEvidence = parts.some((p) => p.criterionEvidence !== undefined)
    ? parts.flatMap((p) => p.criterionEvidence ?? [])
    : undefined;
  return {
    ...first,
    labels: unite((p) => p.labels).slice(0, MAX_LABELS),
    evidenceFindingIndexes: unite((p) => p.evidenceFindingIndexes).slice(0, MAX_EVIDENCE),
    acceptanceCriteria: unite((p) => p.acceptanceCriteria).slice(0, MAX_CRITERIA),
    ...(storyPoints !== undefined ? { storyPoints } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
    ...(criterionEvidence !== undefined ? { criterionEvidence } : {}),
  };
}

export interface RequirementApprovalRow {
  itemId: string;
  status: string;
  createdAt?: Date | null;
  reviewedAt?: Date | null;
}

/**
 * Issue #909 — the deciding approval per structured id. Approval rows are never
 * deleted, and the extractor numbers every run from `REQ-001`, so after a
 * re-run one id carries an approval from each run. The most recently CREATED
 * row belongs to the current list; an older run's verdict must not decide it
 * (an earlier approval would otherwise promote a requirement just rejected).
 */
export function latestRequirementApprovals<T extends RequirementApprovalRow>(
  approvals: readonly T[],
): Map<string, T> {
  const latest = new Map<string, T>();
  for (const a of approvals) {
    const seen = latest.get(a.itemId);
    if (!seen || (a.createdAt?.getTime() ?? 0) >= (seen.createdAt?.getTime() ?? 0)) {
      latest.set(a.itemId, a);
    }
  }
  return latest;
}

/**
 * The requirement set to persist for an analysis whose requirements went
 * through the approval checkpoint: exactly the approved structured
 * requirements, in their reviewed order, with the reviewed title and
 * description. Rejected and still-pending ones are left out.
 */
export function buildApprovedRequirementSet(input: {
  structured: StructuredRequirement[];
  approvedIds: ReadonlySet<string>;
  synthesis: SynthesisOutput | null;
}): SynthesisOutput {
  return planApprovedRequirementSet(input).output;
}

/**
 * Issue #1204 — an approved requirement that received no item because the
 * title join could not tell which of several items was its own. Index-aligned
 * with the persisted set through `approvedIndex` (the requirement's position in
 * `output.requirements`), so the caller can key it by the row it became.
 */
export interface AmbiguousPromotionMatch {
  structuredId: string;
  approvedIndex: number;
  /** The grouped items it was level on, with their criteria to copy across. */
  candidates: Array<{ title: string; acceptanceCriteria: string[] }>;
  /** Each candidate's index in the synthesis output, aligned with `candidates`. */
  synthesizedIndexes: number[];
}

/**
 * Issue #1203 — an approved requirement that received criteria from a
 * synthesis item naming other requirements too. Index-aligned with the
 * persisted set through `approvedIndex`, as {@link AmbiguousPromotionMatch} is.
 */
export interface SharedPromotionMatch {
  structuredId: string;
  approvedIndex: number;
  /**
   * The other listed requirements those items named, in reviewed order.
   * `approvedIndex` is the sibling's position among the approved, or `null`
   * when it was not approved (it gets no row, but its criteria are here).
   */
  sharedWith: Array<{ structuredId: string; title: string; approvedIndex: number | null }>;
  /** The criteria that came from an item naming a sibling, as persisted. */
  sharedCriteria: string[];
  /** Every criterion the requirement is promoted with. */
  promotedCriteria: string[];
}

/**
 * Issue #1203 — which approved requirements share criteria, read off the id
 * join alone: an item naming several listed ids gives each approved one its
 * criteria (#1187). The title fallback is one-to-one and never shares.
 */
function sharedByIdJoin(
  approved: readonly StructuredRequirement[],
  structured: readonly StructuredRequirement[],
  synthesized: readonly SynthesizedRequirement[],
  promoted: readonly SynthesizedRequirement[],
): SharedPromotionMatch[] {
  const listIds = new Set(structured.map((r) => r.id));
  const approvedIndex = new Map(approved.map((r, i) => [r.id, i] as const));
  const out: SharedPromotionMatch[] = [];
  approved.forEach((req, i) => {
    const siblings = new Set<string>();
    const fromShared = new Set<string>();
    for (const s of synthesized) {
      if (!s.structuredIds?.includes(req.id)) continue;
      const others = s.structuredIds.filter((id) => id !== req.id && listIds.has(id));
      if (others.length === 0) continue;
      for (const id of others) siblings.add(id);
      // Synthesis criteria are untrimmed (`z.string().min(1)`); the row's read trimmed.
      for (const c of normalizeCriteria(s.acceptanceCriteria ?? [])) fromShared.add(c);
    }
    if (siblings.size === 0) return;
    // As the row reads back (`parseAcceptanceCriteria`: trimmed, blanks dropped),
    // so the record compares and marks against exactly the criteria on the row.
    // The join caps the list, so a criterion past the cap is not on the row.
    const promotedCriteria = normalizeCriteria(promoted[i]?.acceptanceCriteria ?? []);
    const sharedCriteria = promotedCriteria.filter((c) => fromShared.has(c));
    if (sharedCriteria.length === 0) return;
    out.push({
      structuredId: req.id,
      approvedIndex: i,
      sharedWith: structured
        .filter((r) => siblings.has(r.id))
        .map((r) => ({
          structuredId: r.id,
          title: (r.title.trim() || r.id).slice(0, MAX_TITLE),
          approvedIndex: approvedIndex.get(r.id) ?? null,
        })),
      sharedCriteria,
      promotedCriteria,
    });
  });
  return out;
}

/**
 * Issue #930 — how the reviewed list and the synthesis output differ by
 * IDENTITY, not by count: the reviewed requirements no synthesis item joins
 * onto, and the synthesis items no reviewed requirement takes. Equal counts
 * used to read as "the same set" even when the two named different
 * requirements. Read off the join promotion itself uses (ids, then titles), so
 * the warning and the promoted rows cannot disagree about what matched.
 */
export interface ReviewedSynthesisDifference {
  reviewedWithoutItem: number;
  itemsWithoutReviewed: number;
}

export function compareReviewedWithSynthesis(
  structured: ReadonlyArray<JoinableRequirement>,
  synthesized: readonly SynthesizedRequirement[],
): ReviewedSynthesisDifference {
  const { given } = matchSynthesizedReportingRefusals(structured, synthesized, structured);
  const taken = new Set([...given.values()].flat());
  return {
    reviewedWithoutItem: structured.filter((r) => !given.has(r.id)).length,
    itemsWithoutReviewed: synthesized.filter((_, i) => !taken.has(i)).length,
  };
}

/** Issue #1569 — the id prefix of a requirement offered from a synthesis item. */
export const OFFERED_REQUIREMENT_ID_PREFIX = "SYN-";

const STRUCTURED_BY_PRIORITY: Record<
  SynthesizedRequirement["priority"],
  StructuredRequirement["priority"]
> = {
  critical: "must-have",
  high: "must-have",
  medium: "should-have",
  low: "nice-to-have",
};

/**
 * Issue #1569 — the synthesis items that say they restate NO listed
 * requirement (`structuredIds: []`), as requirements to add to the reviewed
 * list, so the reviewer can approve them with their criteria and evidence
 * rather than have promotion drop them. In #706 run 10, 17 of an agent run's
 * 42 items were such additions (security, schema and operations work the
 * code and database agents found), and none could be promoted.
 *
 * Only that explicit signal is offered. An item that did not say (no
 * `structuredIds`), or that names an id no longer listed, may restate a listed
 * requirement in other words; offering it could put the same requirement up
 * for approval twice, so it stays in the #930 notice instead. An item already
 * offered (its key is on the list) is not offered again, and identical items
 * become one requirement: the join gives it all of them. Pure: the caller
 * appends the result to the list and raises an approval for each.
 */
export function offerUnmatchedSynthesisItems(
  structured: ReadonlyArray<Pick<StructuredRequirement, "id" | "synthesisItemKey">>,
  synthesized: readonly SynthesizedRequirement[],
): StructuredRequirement[] {
  const ids = new Set(structured.map((r) => r.id));
  const keys = new Set(structured.flatMap((r) => r.synthesisItemKey ?? []));
  const out: StructuredRequirement[] = [];
  for (const item of synthesized) {
    if (!Array.isArray(item.structuredIds) || item.structuredIds.length > 0) continue;
    const key = synthesisItemKey(item);
    const id = `${OFFERED_REQUIREMENT_ID_PREFIX}${key.slice(0, 12)}`;
    if (keys.has(key) || ids.has(id)) continue;
    keys.add(key);
    ids.add(id);
    out.push({
      id,
      title: item.title.trim().slice(0, MAX_TITLE),
      description: item.body.trim().slice(0, MAX_BODY),
      // The reviewed list's classification; the promoted row keeps the item's
      // own type, priority and labels (see `planApprovedRequirementSet`).
      type: "functional",
      stakeholders: [],
      priority: STRUCTURED_BY_PRIORITY[item.priority] ?? "should-have",
      ambiguities: [],
      evidenceNeeds: [],
      rawSource: "",
      synthesisItemKey: key,
    });
  }
  return out;
}

/**
 * Issue #1204 review — the synthesis items (indexes) the rows already promoted
 * for `ids` carry, so an append, which re-plans over the enlarged set, never
 * offers one of them to a new row.
 *
 * A row that recorded its items (#1202, in `paired`) carries exactly those,
 * however many appends ago it was written. The rest are replayed together, as
 * {@link planApprovedRequirementSet} would join them with only `ids` approved.
 * That replay is faithful for one promotion, but the set may have been built
 * in several (#1253): replayed as one, requirements that each took an item in
 * their own step can tie on it and take nothing. So when two or more rows have
 * no recorded items, an item that two or more of them tie on also counts as
 * carried. An item only one of them is level on is not: that requirement tied
 * on it alone, in its own step as well. Rows promoted together that tied there
 * too will hide an item none of them took; that only drops an option from a
 * notice, while listing an item another row carries invites copying its
 * criteria across.
 */
export function itemsGivenTo(input: {
  structured: StructuredRequirement[];
  ids: ReadonlySet<string>;
  synthesis: SynthesisOutput | null;
  /** #1202 — the items the promoted rows recorded taking. */
  paired?: PairedItems;
}): Set<number> {
  const synthesized = input.synthesis?.requirements ?? [];
  const approved = input.structured.filter((r) => input.ids.has(r.id));
  const { given, refused } = matchSynthesizedReportingRefusals(
    approved,
    synthesized,
    input.structured,
    input.paired,
  );
  const carried = new Set([...given.values()].flat());
  // Only a tie BETWEEN requirements can be an artefact of replaying separate
  // steps together. One requirement level on two items took neither in its own
  // step too, and those items stay offered (#1253 review, F1).
  const tiedBy = new Map<number, number>();
  for (const r of refused) {
    for (const i of r.synthesizedIndexes) tiedBy.set(i, (tiedBy.get(i) ?? 0) + 1);
  }
  const unrecorded = approved.filter((r) => !input.paired?.has(r.id)).length;
  if (unrecorded > 1) {
    for (const [i, count] of tiedBy) if (count > 1) carried.add(i);
  }
  return carried;
}

/**
 * {@link buildApprovedRequirementSet}, also returning every approved
 * requirement the title join refused (#1204), so promotion can record why it
 * was promoted with no criteria. One matching, read twice — never re-derived.
 */
export function planApprovedRequirementSet(input: {
  structured: StructuredRequirement[];
  approvedIds: ReadonlySet<string>;
  synthesis: SynthesisOutput | null;
  /** #1202 — the items already-promoted rows recorded taking ({@link pairedItemIndexes}). */
  paired?: PairedItems;
}): {
  output: SynthesisOutput;
  ambiguous: AmbiguousPromotionMatch[];
  /** #1203 — the approved requirements whose criteria an item wrote for several. */
  shared: SharedPromotionMatch[];
  /**
   * #1202 — per persisted requirement (index-aligned with `output.requirements`):
   * the structured id it is written from and the keys of the synthesis items it
   * took, for its row to record.
   */
  pairings: Array<PromotionPairing & { synthesisKeys: string[] }>;
} {
  const approved = input.structured.filter((r) => input.approvedIds.has(r.id));
  const synthesized = input.synthesis?.requirements ?? [];
  const { matches, refused, given } = matchSynthesizedReportingRefusals(
    approved,
    synthesized,
    input.structured,
    input.paired,
  );
  const approvedIndex = new Map(approved.map((r, i) => [r.id, i] as const));
  const ambiguous: AmbiguousPromotionMatch[] = refused.map((r) => ({
    structuredId: r.structuredId,
    approvedIndex: approvedIndex.get(r.structuredId)!,
    candidates: r.synthesizedIndexes.map((idx) => ({
      title: synthesized[idx]!.title.slice(0, MAX_TITLE),
      acceptanceCriteria: (synthesized[idx]!.acceptanceCriteria ?? []).slice(0, MAX_CRITERIA),
    })),
    synthesizedIndexes: r.synthesizedIndexes,
  }));

  const requirements: SynthesizedRequirement[] = approved.map((req) => {
    const match = matches.get(req.id);
    const title = (req.title.trim() || req.id).slice(0, MAX_TITLE);
    const body = (req.description.trim() || title).slice(0, MAX_BODY);
    // #1569 — an offered requirement's priority and classification were only
    // derived from its item, so the item's own are kept.
    const offered = req.synthesisItemKey !== undefined ? match : undefined;
    return {
      type: match?.type ?? "feature",
      title,
      body,
      priority:
        offered?.priority ?? PRIORITY_BY_STRUCTURED[req.priority] ?? match?.priority ?? "medium",
      // Issue #909 — the reviewed classification (functional, non-functional,
      // constraint, …) has no counterpart in the row's `type` enum, so it rides
      // as a label rather than being dropped.
      labels: [
        ...new Set([...(offered ? [] : [req.type]), ...(match?.labels ?? [])].filter(Boolean)),
      ].slice(0, MAX_LABELS),
      ...(match?.storyPoints !== undefined ? { storyPoints: match.storyPoints } : {}),
      evidenceFindingIndexes: match?.evidenceFindingIndexes ?? [],
      acceptanceCriteria: match?.acceptanceCriteria ?? [],
      // #1610 — travels with the criteria it describes.
      ...(match?.criterionEvidence !== undefined
        ? { criterionEvidence: match.criterionEvidence }
        : {}),
      // #1063 — which imported item it came from, when synthesis said.
      ...(match?.sourceIds !== undefined ? { sourceIds: match.sourceIds } : {}),
    };
  });

  return {
    output: {
      summary:
        input.synthesis?.summary ??
        `${requirements.length} approved requirement(s) promoted from the approval checkpoint.`,
      requirements,
    },
    ambiguous,
    shared: sharedByIdJoin(approved, input.structured, synthesized, requirements),
    pairings: approved.map((req) => ({
      structuredId: req.id,
      synthesisKeys: (given.get(req.id) ?? []).map((i) => synthesisItemKey(synthesized[i]!)),
    })),
  };
}
