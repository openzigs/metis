/**
 * Issue #1613 — the NFRs the elicitor (#231) finds, as draft non-functional
 * requirements a BA can review.
 *
 * Until now `runElicitation` only fed the completeness checker a text block
 * (`formatElicitedArtifacts`), so an elicited NFR was never a requirement
 * anyone could see or approve. This turns each one into a synthesized-
 * requirement shape that `persistRequirements` writes beside the synthesis set:
 *
 *   - `kind: "non-functional"` with the elicitor's category (#1612).
 *   - Evidence is the corpus sections the model cited, which are analysis
 *     findings (`runCrossDocDetectionAndPersist` builds one section per
 *     finding), mapped to the synthesis's finding indexes. An NFR citing
 *     nothing has no evidence indexes, so the existing roll-ups give it
 *     `no_evidence` and never `implemented` (NFR-2: no fabrication).
 *   - One the synthesis already states is dropped, never written twice (see
 *     {@link statesSameNfr}), and one run adds at most
 *     {@link MAX_ELICITED_NFRS_PER_RUN}. Every drop is returned for the caller
 *     to log (#1648).
 *   - Its verdict never claims more than `could-not-verify`
 *     ({@link capElicitedNfrVerdict}, #1648).
 *
 * The body is the model's text as-is. It is data: every prompt that later
 * quotes a requirement body fences it there (#1114, #1351), so nothing is
 * escaped here, where a second encoding would only corrupt what the BA reads.
 *
 * Pure.
 */
import { z } from "zod";
import {
  NFR_CATEGORIES,
  nfrSchema,
  type ElicitationPriority,
  type Nfr,
  type RequirementPriority,
  type RequirementVerdict,
  type SynthesizedRequirement,
} from "@metis/shared";
import { requirementKindColumns } from "./requirement-kind.js";

/** The label that tells a reviewer a requirement came from NFR elicitation. */
export const ELICITED_NFR_LABEL = "elicited-nfr";

/**
 * Issue #1648 — the most elicited NFRs one run adds as draft rows. The schema's
 * `max(200)` is a parse bound, not a review budget: a BA reviews every row, so
 * a run past this keeps the first ones in elicitation order and reports the
 * rest as dropped.
 */
export const MAX_ELICITED_NFRS_PER_RUN = 20;

const PRIORITY: Record<ElicitationPriority, RequirementPriority> = {
  "must-have": "high",
  "should-have": "medium",
  "nice-to-have": "low",
};

/**
 * Lower-case tokens: a number with its decimal point (`1.5`, `99.9`), a run of
 * letters, or a run of comparison / percent signs. Everything else separates.
 * A number is one token, so `200` never matches inside `1200` and `1.5s` never
 * reads as `15s` (#1648).
 */
function tokens(text: string): string[] {
  return text.toLowerCase().match(/\p{N}+(?:\.\p{N}+)?|\p{L}+|[%<>=]+/gu) ?? [];
}

/** Whether `needle` occurs in `haystack` as a contiguous token sequence. */
function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, j) => haystack[i + j] === t)) return true;
  }
  return false;
}

/**
 * Words that say what KIND of quality an NFR is about, or join a phrase,
 * rather than what it is about: they cannot tell "API uptime 99.9%" from
 * "database uptime 99.9%".
 */
const GENERIC_WORDS = new Set<string>([
  ...NFR_CATEGORIES,
  ...["a", "an", "the", "of", "for", "and", "or", "to", "in", "on", "at", "by", "with", "per"],
  ...["under", "all", "every", "must", "should", "shall", "be", "is", "are"],
  ...["uptime", "latency", "response", "responses", "time", "times", "throughput"],
  ...["fast", "quick", "speed", "rate", "target", "requirement", "system"],
]);

/** The words of an NFR's title that name its subject: not numbers, signs or generic words. */
function subjectWords(nfr: Nfr, metric: readonly string[]): string[] {
  return tokens(nfr.title).filter(
    (t) => /^\p{L}{2,}$/u.test(t) && !GENERIC_WORDS.has(t) && !metric.includes(t),
  );
}

/** A requirement an elicited NFR is compared with: a synthesis row or an earlier NFR. */
export interface ComparableRequirement {
  title: string;
  body: string;
  kind?: unknown;
  nfrCategory?: unknown;
}

/**
 * True when `existing` already states `nfr`:
 *
 *   - the same title once case, spacing and punctuation are ignored; or
 *   - a requirement of the SAME NFR category whose title or body carries the
 *     NFR's measurable target as a whole token sequence, and names at least
 *     one word of the NFR's subject ("p95 < 300ms" for "Fast API" in
 *     "Responsive API … p95 < 300 ms …"). A shared target alone is not
 *     enough: "99.9%" for the API and "99.9%" for the database are two NFRs
 *     (#1648).
 *
 * A requirement with no category (functional, or unclassified) is compared on
 * its title only.
 */
export function statesSameNfr(nfr: Nfr, existing: ComparableRequirement): boolean {
  const title = tokens(nfr.title).join(" ");
  if (title.length > 0 && title === tokens(existing.title).join(" ")) return true;
  if (requirementKindColumns(existing).nfrCategory !== nfr.category) return false;
  const metric = tokens(nfr.metric);
  const text = tokens(`${existing.title} ${existing.body}`);
  if (!containsSequence(text, metric)) return false;
  const subject = subjectWords(nfr, metric);
  return subject.length === 0 || subject.some((w) => text.includes(w));
}

/** An elicited NFR that was not written, and why (#1648: nothing is dropped silently). */
export interface DroppedNfr {
  title: string;
  reason: "duplicate" | "over-cap";
  /** For `duplicate`: the title of the requirement that already states it. */
  duplicateOf?: string;
}

function body(nfr: Nfr): string {
  return nfr.metric ? `${nfr.description}\n\nTarget: ${nfr.metric}` : nfr.description;
}

/**
 * The elicited NFRs to write as requirements, in elicitation order, with any
 * the synthesis set (or an earlier NFR in the list) already states removed and
 * at most {@link MAX_ELICITED_NFRS_PER_RUN} kept. `findingIdsByIndex` is the
 * synthesis's index → finding id map; an evidence id that names no finding in
 * it is not evidence and is dropped. `dropped` lists every NFR not written.
 */
export function elicitedNfrRequirements(input: {
  nfrs: Nfr[];
  findingIdsByIndex: string[];
  existing: ComparableRequirement[];
}): { requirements: SynthesizedRequirement[]; dropped: DroppedNfr[] } {
  const indexOf = new Map(input.findingIdsByIndex.map((id, i) => [id, i]));
  const kept: SynthesizedRequirement[] = [];
  const dropped: DroppedNfr[] = [];
  const seen: ComparableRequirement[] = [...input.existing];
  for (const nfr of input.nfrs) {
    const same = seen.find((e) => statesSameNfr(nfr, e));
    if (same) {
      dropped.push({ title: nfr.title, reason: "duplicate", duplicateOf: same.title });
      continue;
    }
    if (kept.length >= MAX_ELICITED_NFRS_PER_RUN) {
      dropped.push({ title: nfr.title, reason: "over-cap" });
      continue;
    }
    const requirement: SynthesizedRequirement = {
      type: "feature",
      title: nfr.title,
      body: body(nfr),
      priority: PRIORITY[nfr.priority],
      labels: [ELICITED_NFR_LABEL],
      evidenceFindingIndexes: [
        ...new Set(
          (nfr.evidenceIds ?? [])
            .map((id) => indexOf.get(id))
            .filter((i): i is number => i !== undefined),
        ),
      ],
      acceptanceCriteria: [],
      kind: "non-functional",
      nfrCategory: nfr.category,
    };
    kept.push(requirement);
    seen.push(requirement);
  }
  return { requirements: kept, dropped };
}

/**
 * Issue #1705 — the metadata key holding the NFRs a gate-blocked run elicited,
 * until its approved set is promoted. The orchestrator returns from synthesis
 * before writing any requirement when the approval gate blocks promotion, so
 * the NFRs wait here for `promoteApprovedRequirements`, which writes them with
 * the approved set and clears the key. Absent when nothing is waiting.
 */
export const ELICITED_NFRS_AWAITING_PROMOTION_KEY = "elicitedNfrsAwaitingPromotion";

const awaitingNfrsSchema = z.array(nfrSchema);

/**
 * The NFRs waiting on an analysis for promotion (#1705). A value that is not a
 * list of NFRs (hand-edited, or from a different version) reads as none: the
 * cost is a draft nobody sees, never a malformed row.
 */
export function readElicitedNfrsAwaitingPromotion(metadata: Record<string, unknown>): Nfr[] {
  const parsed = awaitingNfrsSchema.safeParse(metadata[ELICITED_NFRS_AWAITING_PROMOTION_KEY]);
  return parsed.success ? parsed.data : [];
}

/**
 * Issue #1648 — the verdict an elicited NFR may carry. The findings it cites
 * are the ones the elicitor read the NFR from; their code verdicts answer those
 * findings' own claims, not this NFR. So a confident verdict (`implemented`,
 * `partial`, `gap-confirmed`) rolled up from them is capped to
 * `could-not-verify`. Null (no code analysis ran) stays null.
 */
export function capElicitedNfrVerdict(
  verdict: RequirementVerdict | null,
): RequirementVerdict | null {
  return verdict === null ? null : "could-not-verify";
}
