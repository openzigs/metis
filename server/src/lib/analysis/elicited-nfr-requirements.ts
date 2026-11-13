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
import { synthesisItemKey } from "./promotion-pairing.js";
import { requirementKindColumns } from "./requirement-kind.js";
import type { StructuredRequirement } from "./types/requirements.js";

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
function subjectWords(nfr: Pick<Nfr, "title">, metric: readonly string[]): string[] {
  return tokens(nfr.title).filter(
    (t) => /^\p{L}{2,}$/u.test(t) && !GENERIC_WORDS.has(t) && !metric.includes(t),
  );
}

/** #1709 — abbreviations a subject is often written with, read as the word they stand for. */
const SUBJECT_ABBREVIATIONS: Readonly<Record<string, string>> = {
  db: "database",
  dbs: "database",
};

/**
 * #1709 — the endings by which two forms of one subject word differ: a plural
 * (`APIs`, `databases`) or a verb and its noun or participle (`encrypt`,
 * `encryption`, `encrypted`, `encrypting`).
 */
const SUBJECT_WORD_ENDINGS = new Set(["s", "es", "ion", "ions", "ed", "ing"]);

/**
 * #1709 — whether two subject words name the same thing: equal once an
 * abbreviation is expanded, or one is the other plus one of
 * {@link SUBJECT_WORD_ENDINGS}, its stem at least three letters (five for -ion). Deliberately
 * light: a missed variant only leaves an extra draft for the BA to reject,
 * where a wider rule would drop an NFR the set does not state.
 */
export function sameSubjectWord(a: string, b: string): boolean {
  const x = SUBJECT_ABBREVIATIONS[a] ?? a;
  const y = SUBJECT_ABBREVIATIONS[b] ?? b;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const ending = long.slice(short.length);
  // An -ion on a short stem joins unrelated words (`port`/`portion`,
  // `opt`/`option`), and a false match drops an NFR, so it needs five letters.
  const minStem = ending.startsWith("ion") ? 5 : 3;
  return short.length >= minStem && long.startsWith(short) && SUBJECT_WORD_ENDINGS.has(ending);
}

/**
 * #2449 — words that join a title's phrase rather than say what it is about.
 * Deliberately not {@link GENERIC_WORDS}: "API uptime 99.9%" and "API latency
 * 99.9%" are two titles.
 */
const TITLE_JOINERS = new Set<string>([
  ...["a", "an", "the", "of", "for", "and", "or", "to", "in", "on", "at", "by", "with", "per"],
  ...["is", "are", "be", "must", "should", "shall", "after", "within", "from", "its"],
]);

/**
 * #2449 — whether two title words are one word in two forms: as
 * {@link sameSubjectWord} reads them, or one five-letter stem with endings of at
 * most three letters each (`expires` / `expiry`, `secure` / `security`).
 */
function sameTitleWord(a: string, b: string): boolean {
  if (sameSubjectWord(a, b)) return true;
  const STEM = 5;
  const formOf = (w: string) => /^\p{L}+$/u.test(w) && w.length >= STEM && w.length <= STEM + 3;
  return formOf(a) && formOf(b) && a.slice(0, STEM) === b.slice(0, STEM);
}

/**
 * #2449 — whether two titles say the same thing in other word forms: every
 * word of each, joiners aside, is a word of the other ({@link sameTitleWord}),
 * numbers and signs exactly. "Reset link expiry after 30 minutes" restates
 * "Reset link expires after 30 minutes"; "… after 15 minutes" does not.
 *
 * A word one title adds is enough to keep them apart: "Password reset link
 * expiry" is not dropped as "Password reset link". A paraphrase ("must not
 * reveal account existence" for "account-enumeration protection") is not read
 * as one either. Both are offered at the approval checkpoint, marked as
 * elicited, where the analyst can reject them; a wider rule would drop an NFR
 * the set does not state, and nobody would see it.
 */
export function restatesTitle(a: string, b: string): boolean {
  const words = (title: string) => tokens(title).filter((t) => !TITLE_JOINERS.has(t));
  const x = words(a);
  const y = words(b);
  if (x.length === 0 || y.length === 0) return false;
  const covered = (from: string[], into: string[]) =>
    from.every((w) => into.some((v) => sameTitleWord(w, v)));
  return covered(x, y) && covered(y, x);
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
 *   - the same title once case, spacing and punctuation are ignored, or the
 *     same title in other word forms ({@link restatesTitle}, #2449); or
 *   - a requirement of the SAME NFR category whose title or body carries the
 *     NFR's measurable target as a whole token sequence, and names at least
 *     one word of the NFR's subject ("p95 < 300ms" for "Fast API" in
 *     "Responsive API … p95 < 300 ms …"). A shared target alone is not
 *     enough: "99.9%" for the API and "99.9%" for the database are two NFRs
 *     (#1648). A plural, an `-ion` / `-ed` / `-ing` form or `DB` names the
 *     same subject word ({@link sameSubjectWord}, #1709); a synonym does not.
 *
 * A requirement with no category (functional, or unclassified) is compared on
 * its title only.
 */
export function statesSameNfr(
  nfr: Pick<Nfr, "title" | "category" | "metric">,
  existing: ComparableRequirement,
): boolean {
  const title = tokens(nfr.title).join(" ");
  if (title.length > 0 && title === tokens(existing.title).join(" ")) return true;
  if (restatesTitle(nfr.title, existing.title)) return true;
  if (requirementKindColumns(existing).nfrCategory !== nfr.category) return false;
  const metric = tokens(nfr.metric);
  const text = tokens(`${existing.title} ${existing.body}`);
  if (!containsSequence(text, metric)) return false;
  const subject = subjectWords(nfr, metric);
  return subject.length === 0 || subject.some((w) => text.some((t) => sameSubjectWord(w, t)));
}

const TARGET_PREFIX = "\n\nTarget: ";

/**
 * #1709 — the NFR an elicited row states, read back from what the row stores:
 * its title, its category and the target its body ends with (as
 * {@link elicitedNfrRequirements} writes it). Null when the row has no NFR
 * category, so nothing can be compared beyond its title.
 */
export function nfrStatedByRow(row: {
  title: string;
  body: string;
  nfrCategory: string | null;
}): Pick<Nfr, "title" | "category" | "metric"> | null {
  const category = NFR_CATEGORIES.find((c) => c === row.nfrCategory);
  if (!category) return null;
  const at = row.body.lastIndexOf(TARGET_PREFIX);
  const metric = at >= 0 ? row.body.slice(at + TARGET_PREFIX.length).trim() : "";
  return { title: row.title, category, metric };
}

/** An elicited NFR that was not written, and why (#1648: nothing is dropped silently). */
export interface DroppedNfr {
  title: string;
  reason: "duplicate" | "over-cap";
  /** For `duplicate`: the title of the requirement that already states it. */
  duplicateOf?: string;
}

function body(nfr: Nfr): string {
  return nfr.metric ? `${nfr.description}${TARGET_PREFIX}${nfr.metric}` : nfr.description;
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

/** Issue #2449 — the id prefix of a requirement offered at the checkpoint from an elicited NFR. */
export const ELICITED_NFR_REQUIREMENT_ID_PREFIX = "NFR-";

const STRUCTURED_PRIORITY: Record<RequirementPriority, ElicitationPriority> = {
  critical: "must-have",
  high: "must-have",
  medium: "should-have",
  low: "nice-to-have",
};

/**
 * Issue #2449 — the elicited NFRs to add to the reviewed (structured) list, so
 * the approval checkpoint lists every requirement promotion will write. Before
 * this, a gate-blocked run's NFRs waited on the analysis (#1705) and promotion
 * wrote them beside the approved set: approving 6 requirements wrote 15, and
 * several of the 9 nobody saw restated an approved one.
 *
 * Each NFR is checked against the reviewed list (an offered NFR there by its
 * category, target and subject; any other requirement by its title) and the
 * synthesis items, by {@link elicitedNfrRequirements}'s rules, and is not
 * offered when one of them states it; at most {@link MAX_ELICITED_NFRS_PER_RUN}
 * are offered. One already listed is stated by itself, so a re-run of the
 * blocked run never offers it twice. Its id is a hash of its title and body,
 * as a synthesis item's (#1569). Pure: the
 * caller appends the result and raises an approval for each. `dropped` lists
 * every NFR not offered, for the caller to log (#1648).
 */
export function offerElicitedNfrs(input: {
  structured: readonly StructuredRequirement[];
  nfrs: Nfr[];
  findingIdsByIndex: string[];
  synthesized: readonly SynthesizedRequirement[];
}): { offered: StructuredRequirement[]; dropped: DroppedNfr[] } {
  const listed: ComparableRequirement[] = input.structured.map((r) => ({
    title: r.title,
    body: r.description,
    ...(r.elicitedNfr
      ? { kind: "non-functional", nfrCategory: r.elicitedNfr.nfrCategory }
      : { kind: r.type }),
  }));
  const { requirements, dropped } = elicitedNfrRequirements({
    nfrs: input.nfrs,
    findingIdsByIndex: input.findingIdsByIndex,
    existing: [...listed, ...input.synthesized],
  });
  const offered: StructuredRequirement[] = [];
  for (const r of requirements) {
    // Always set on an elicited NFR; read here for its type.
    if (!r.nfrCategory) continue;
    offered.push({
      id: `${ELICITED_NFR_REQUIREMENT_ID_PREFIX}${synthesisItemKey(r).slice(0, 12)}`,
      title: r.title.slice(0, 255),
      description: r.body,
      type: "non-functional",
      stakeholders: [],
      priority: STRUCTURED_PRIORITY[r.priority],
      ambiguities: [],
      evidenceNeeds: [],
      rawSource: "",
      elicitedNfr: {
        nfrCategory: r.nfrCategory,
        evidenceFindingIndexes: r.evidenceFindingIndexes,
      },
    });
  }
  return { offered, dropped };
}

/**
 * Issue #2449 — {@link capElicitedNfrVerdict} over a promoted set: the verdict
 * of each row labelled {@link ELICITED_NFR_LABEL} is capped, every other
 * verdict is kept. Index-aligned with `requirements`.
 */
export function capElicitedNfrVerdicts(
  requirements: ReadonlyArray<Pick<SynthesizedRequirement, "labels">>,
  verdicts: ReadonlyArray<RequirementVerdict | null>,
): Array<RequirementVerdict | null> {
  return verdicts.map((v, i) =>
    requirements[i]?.labels.includes(ELICITED_NFR_LABEL) ? capElicitedNfrVerdict(v) : v,
  );
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
