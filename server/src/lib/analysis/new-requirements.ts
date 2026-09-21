/**
 * New-requirement candidates from the operator's free-text box (Issue #768).
 *
 * The "Evaluate new requirements" input (`extraInstructions` on
 * `StartAnalysisOptions`) is METIS's headline use case: paste a requirement, get
 * back what code must change. Before #768 that text was ONLY fenced into the
 * agent prompt as operator notes and (via #735) mapped to code *after* the code
 * agent's mode had already been chosen from DOCUMENT-extracted requirements —
 * so a project whose documents carry no requirements collapsed to `single-shot`
 * and never investigated the code. Circular: to analyse YOUR new requirement
 * against code, the pipeline first needed OTHER requirements to already exist.
 *
 * This module turns the free text into first-class requirement candidates that
 * feed `detectAgentMode` and the code agent's requirement set. It REUSES #735's
 * deterministic, LLM-free splitter (`heuristicChangeExtractor`) — no new parser,
 * no extra model call — and mints the SAME `NR-*` ids that
 * `computeAffectedCodeContext` mints, so a candidate's blast-radius mapping and
 * its requirement entry are traceable to one another.
 */
import {
  MAX_EXTRA_INSTRUCTIONS,
  requirementInputExcerpt,
  type DroppedRequirementInput,
  type MergedRequirementInput,
  type RequirementInputAccount,
} from "@metis/shared";
import { heuristicChangeExtractor } from "../impact-analysis/extract-changes.js";
import { getConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("new-requirements");

/** Requirement shape the orchestrator threads through the code agents. */
export interface RequirementRef {
  id: string;
  text: string;
}

/** Max candidates parsed out of the free-text box (shared with #735's mapping). */
export const DEFAULT_NEW_REQUIREMENT_MAX_CANDIDATES = 8;

/**
 * The `NR-*` id namespace for new-requirement candidates — deliberately DISJOINT
 * from the document agent's `REQ-*` ids so downstream code (#735 affected-code,
 * #736 coverage, the UI) can still tell "the user asked for this" apart from
 * "the documents already said this". `index` is 0-based.
 */
export function newRequirementId(index: number): string {
  return `NR-${index + 1}`;
}

/**
 * Issue #1112 — the extraction result WITH its input-side account. Every block
 * the splitter produced is either a candidate or a `dropped` entry naming why,
 * so `parsedCount === candidates.length + dropped.length` always holds.
 */
export interface NewRequirementExtraction {
  /** Candidates that survived the cap and carry text. */
  candidates: RequirementRef[];
  /** Requirement blocks the splitter produced, BEFORE the cap. */
  parsedCount: number;
  /** Blocks that never became candidates, each naming why (#1101's silent slice). */
  dropped: DroppedRequirementInput[];
  /** The submitted paste hit {@link MAX_EXTRA_INSTRUCTIONS} and lost its tail. */
  inputTruncated: boolean;
}

/**
 * Split the operator's free-text new requirements into discrete requirement
 * candidates AND account for every block that did not become one.
 *
 * Deterministic and LLM-free (paragraph/bullet split). Never throws: an
 * empty/unparseable box yields no candidates, which leaves mode detection exactly
 * as it was before #768.
 *
 * Issue #1112 (from #1101): the cap used to be a bare `.slice()`. Seven
 * requirements each carrying their own acceptance-criteria bullets split into
 * more than eight blocks, the tail was cut, and the run reported success. The cap
 * still caps — raising it is a separate judgement, and a bigger cap that truncates
 * in silence is the same bug at a different number — but what it removes is now
 * REPORTED.
 */
export async function extractNewRequirementCandidatesWithAccount(
  extraInstructions?: string | null,
  maxCandidates?: number,
): Promise<NewRequirementExtraction> {
  const raw = extraInstructions ?? "";
  const text = raw.trim();
  // Drop point 3 (#1101): the textarea slices at the input limit, so a paste that
  // arrives AT the limit almost certainly lost its tail before we ever saw it.
  const inputTruncated = raw.length >= MAX_EXTRA_INSTRUCTIONS;
  const none: NewRequirementExtraction = {
    candidates: [],
    parsedCount: 0,
    dropped: [],
    inputTruncated,
  };
  if (text.length === 0) return none;

  let changes;
  try {
    changes = await heuristicChangeExtractor.extract(text);
  } catch (err) {
    log.warn("new-requirement candidate extraction failed; treating as none", {
      error: String(err),
    });
    return none;
  }

  const cap =
    maxCandidates ??
    getConfigService().getNumber(
      "ANALYSIS_AFFECTED_CODE_MAX_CANDIDATES",
      DEFAULT_NEW_REQUIREMENT_MAX_CANDIDATES,
    );
  const effectiveCap = Math.max(0, cap);

  const candidates: RequirementRef[] = [];
  const dropped: DroppedRequirementInput[] = [];
  changes.forEach((change, i) => {
    // Ids stay indexed against the FULL parsed list, so the id in a drop notice is
    // the id the requirement would have carried had it survived.
    const id = newRequirementId(i);
    const body = change.body.trim();
    if (i >= effectiveCap) {
      dropped.push({
        id,
        excerpt: requirementInputExcerpt(body.length > 0 ? body : change.title),
        reason: "candidate-cap",
      });
      return;
    }
    if (body.length === 0) {
      dropped.push({ id, excerpt: requirementInputExcerpt(change.title), reason: "unparseable" });
      return;
    }
    candidates.push({ id, text: body });
  });

  if (dropped.length > 0 || inputTruncated) {
    log.warn("new-requirement inputs were discarded before analysis", {
      parsedCount: changes.length,
      droppedCount: dropped.length,
      inputTruncated,
    });
  }
  return { candidates, parsedCount: changes.length, dropped, inputTruncated };
}

/**
 * Candidates only — the pre-#1112 signature, kept for the call sites that do not
 * build an account (e.g. the multi-repo resume path, which must reconstruct the
 * ORIGINAL run's requirement set and whose account was already reported then).
 */
export async function extractNewRequirementCandidates(
  extraInstructions?: string | null,
  maxCandidates?: number,
): Promise<RequirementRef[]> {
  return (await extractNewRequirementCandidatesWithAccount(extraInstructions, maxCandidates))
    .candidates;
}

/** Case-folded, punctuation-collapsed form used for duplicate detection. */
function normalizeRequirementText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Words carrying no discriminating signal for requirement identity. Dropping them
 * means "The system SHALL expose a health endpoint" and "expose a health endpoint"
 * are recognised as the same requirement — which matters because the DOCUMENT
 * agent, having been shown the operator notes, frequently re-emits the operator's
 * sentence in spec voice.
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "must",
  "of",
  "on",
  "or",
  "shall",
  "should",
  "so",
  "system",
  "that",
  "the",
  "then",
  "there",
  "this",
  "to",
  "we",
  "when",
  "will",
  "with",
]);

/** Content tokens of a requirement (normalised, stop-words removed). */
function contentTokens(text: string): Set<string> {
  return new Set(
    normalizeRequirementText(text)
      .split(" ")
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w)),
  );
}

/**
 * Jaccard overlap of two requirements' content tokens. 1 ⇒ same content words.
 * Deterministic and LLM-free (this whole path must stay offline-safe).
 */
function contentOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Content-token overlap at/above which two requirements are treated as the SAME
 * requirement.
 *
 * Calibrated against the two cases that matter:
 *   - The document agent's spec-voice ECHO of a pasted requirement ("The system
 *     SHALL rate limit the AI chat endpoint to 20 requests per minute per user."
 *     vs "REQ-1: The AI chat endpoint SHALL rate limit each user to 20 requests
 *     per minute.") scores ≈0.77 — it MUST collapse, or the same requirement is
 *     investigated twice.
 *   - Two requirements that merely share a subject ("add rate limiting to the AI
 *     chat endpoint" vs "add response caching to the AI chat endpoint") score
 *     ≈0.5 — they MUST NOT collapse, or the user's requirement is silently lost.
 *
 * 0.7 separates them with room on both sides. Erring toward keeping (a
 * requirement analysed twice) is strictly safer than dropping one the user typed.
 */
export const DUPLICATE_REQUIREMENT_OVERLAP = 0.7;

/**
 * Merge document-extracted requirements with new-requirement candidates into the
 * single set the code agent works from.
 *
 * Document requirements keep their position and ids, so a run with no new
 * requirements is byte-identical to the pre-#768 behaviour. A candidate that is
 * the SAME requirement as one already in the document set is dropped, so a
 * requirement is never investigated twice.
 *
 * Why this de-dupe is load-bearing (#768): the operator's free text is ALSO
 * rendered into the document agent's prompt as fenced operator notes, and #750's
 * extraction prompt can lift it into `requirements[]` — verbatim or, more often,
 * rephrased into spec voice ("The system SHALL …"). So the doc set may already
 * contain the very requirements we parse here. Matching therefore tolerates
 * rephrasing: exact match, containment, or ≥{@link DUPLICATE_REQUIREMENT_OVERLAP}
 * content-token overlap all collapse. Anything less similar survives as its own
 * `NR-*` requirement — we would rather analyse a requirement twice than silently
 * discard the one the user actually typed.
 */
export function mergeRequirementSets(
  documentRequirements: readonly RequirementRef[],
  newRequirements: readonly RequirementRef[],
): RequirementRef[] {
  return mergeRequirementSetsWithAccount(documentRequirements, newRequirements).requirements;
}

/**
 * Issue #1112 — the merge result WITH its account. `merged` names, for each
 * collapsed candidate, the requirement that SURVIVED and now carries its intent;
 * `dropped` holds candidates whose text normalised to nothing (all punctuation),
 * which the pre-#1112 loop skipped in silence.
 */
export interface RequirementMergeResult {
  /** The requirement set the code agent works from. */
  requirements: RequirementRef[];
  /** Candidates folded into another requirement as duplicates — accounted for, not lost. */
  merged: MergedRequirementInput[];
  /** Candidates that carried no usable requirement text. */
  dropped: DroppedRequirementInput[];
}

/**
 * {@link mergeRequirementSets}, additionally reporting what the de-dupe removed.
 *
 * Drop point 2 of #1101: a candidate at ≥{@link DUPLICATE_REQUIREMENT_OVERLAP}
 * overlap with an existing requirement is removed. That is the right call — the
 * same requirement must not be investigated twice — but until #1112 the removal
 * was invisible, so a user who pasted a deliberate refinement watched it vanish.
 * A merge now names its survivor, which is a materially different statement from
 * a drop and must never be presented as one.
 */
export function mergeRequirementSetsWithAccount(
  documentRequirements: readonly RequirementRef[],
  newRequirements: readonly RequirementRef[],
): RequirementMergeResult {
  const requirements: RequirementRef[] = [...documentRequirements];
  const seen = documentRequirements.map((r) => ({
    id: r.id,
    text: r.text,
    normalized: normalizeRequirementText(r.text),
    tokens: contentTokens(r.text),
  }));
  const merged: MergedRequirementInput[] = [];
  const dropped: DroppedRequirementInput[] = [];

  for (const candidate of newRequirements) {
    const normalized = normalizeRequirementText(candidate.text);
    if (normalized.length === 0) {
      dropped.push({
        id: candidate.id,
        excerpt: requirementInputExcerpt(candidate.text),
        reason: "unparseable",
      });
      continue;
    }
    const tokens = contentTokens(candidate.text);

    const survivor = seen.find(
      (existing) =>
        existing.normalized === normalized ||
        // One states the other plus extra framing ("REQ-1: <the pasted sentence>").
        existing.normalized.includes(normalized) ||
        normalized.includes(existing.normalized) ||
        contentOverlap(existing.tokens, tokens) >= DUPLICATE_REQUIREMENT_OVERLAP,
    );
    if (survivor) {
      merged.push({
        id: candidate.id,
        excerpt: requirementInputExcerpt(candidate.text),
        mergedIntoId: survivor.id,
        mergedIntoExcerpt: requirementInputExcerpt(survivor.text),
      });
      continue;
    }

    seen.push({ id: candidate.id, text: candidate.text, normalized, tokens });
    requirements.push(candidate);
  }
  return { requirements, merged, dropped };
}

/**
 * Issue #1112 (Epic #1107) — assemble the run's input-side coverage from the two
 * stages that can discard a user-supplied requirement.
 *
 * Every block parsed out of the paste lands in exactly one bucket: analyzed,
 * merged (naming the survivor), or dropped (naming the reason). That completeness
 * is the whole point — it is what makes "we lost nothing" a checkable claim
 * rather than an assumption (`isRequirementInputAccountBalanced`).
 *
 * The account is NOT itself capped, deliberately: capping the report of a
 * truncation is the same bug one level up. It stays small without a cap because
 * the excerpts are slices of an input already bounded at
 * `MAX_EXTRA_INSTRUCTIONS` characters, so their total can never exceed it.
 */
export function buildRequirementInputAccount(
  extraction: NewRequirementExtraction,
  merge: Pick<RequirementMergeResult, "merged" | "dropped">,
): RequirementInputAccount {
  const accountedElsewhere = new Set<string>([
    ...merge.merged.map((m) => m.id),
    ...merge.dropped.map((d) => d.id),
  ]);
  return {
    parsedCount: extraction.parsedCount,
    analyzedIds: extraction.candidates.map((c) => c.id).filter((id) => !accountedElsewhere.has(id)),
    merged: [...merge.merged],
    dropped: [...extraction.dropped, ...merge.dropped],
    inputTruncated: extraction.inputTruncated,
  };
}
