/**
 * Issue #1116 — **carry the user's clarification answers into the persisted
 * requirements, not just the approval view.**
 *
 * The defect, precisely: `Requirement` rows are written by `persistRequirements`
 * from the SYNTHESIS agent's frozen `AgentResult` output. Synthesis reads the
 * clarification-refined `structuredRequirements` (orchestrator →
 * `getStructuredRequirements` → `refinedRequirements`) at the moment it runs —
 * which is BEFORE the user has seen a single clarifying question. The user then
 * answers, the clarify route rewrites `metadata.structuredRequirements`, and the
 * Approvals panel visibly improves … while the artifact path (requirements →
 * drafts → GitHub issues) still replays the pre-clarification synthesis output.
 * Nothing ever re-reads the enriched representation, so the answers reach the
 * screen and never the issue.
 *
 * This module closes that last hop WITHOUT another LLM call and without
 * re-running synthesis (which would invalidate approvals the user already gave).
 * It writes the answers themselves — verbatim, attributed — into the
 * `Requirement.body` that the draft generator publishes, inside HTML-comment
 * markers so re-running is idempotent rather than additive.
 *
 * It is called from BOTH orderings the product allows:
 *   - answers submitted while the approval gate still withholds the rows
 *     (`promoteApprovedRequirements` applies them once the rows exist), and
 *   - answers submitted after the rows were already persisted (the clarify
 *     route applies them immediately).
 *
 * What is deliberately NOT copied: the clarify LLM's rewritten
 * `StructuredRequirement.description`. It belongs to a different, disjoint id
 * space from the synthesized requirements, so overwriting a synthesized body
 * with it would be a paraphrase swap with no traceability. The accounting this
 * module persists is what tells the user that (see `ClarificationApplication`
 * and the UI note it feeds).
 */
import { findMetisMarkers, parseAcceptanceCriteria } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import {
  RequirementVersionError,
  updateRequirementWithHistory,
  type VersionPrismaClient,
} from "../requirements/requirement-version-service.js";
import { getStructuredRequirements, persistAnalysisEnhancement } from "./analysis-service.js";
import {
  CRITERIA_FLAG_LINE,
  canonicalizeCriteriaFlag,
  clearCriteriaFlag,
  hasCriteriaFlag,
} from "./clarification-criteria-flag.js";
import { readDialogState } from "./clarification-dialog-store.js";
import {
  compareTiersDescending,
  matchOneToOneRefusingTies,
  type OneToOneCandidate,
  type OneToOneResult,
} from "./one-to-one-match.js";
import type {
  AnswerProvenance,
  ClarificationApplication,
  ClarificationState,
  StructuredRequirement,
  StructuredRequirements,
} from "./types/requirements.js";

export type { AnswerProvenance, ClarificationApplication } from "./types/requirements.js";

const log = createChildLogger("clarification-enrichment");

/** One answered clarifying question, resolved to the text actually submitted. */
export interface AnsweredQuestion {
  questionId: string;
  /** The STRUCTURED requirement id the question was asked about (may be ""). */
  requirementId: string;
  question: string;
  answer: string;
  /** Issue #1000 — who wrote the answer (see {@link answerProvenance}). */
  provenance: AnswerProvenance;
}

/** Whitespace-insensitive form used to compare an answer with a suggestion. */
function normalised(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Issue #1000 — where an answer came from. The clarify form pre-fills a
 * grounded question with METIS's suggested answer, so submitting it unchanged
 * is METIS's answer accepted, not the requester's own. Deterministic: decided by
 * comparing the submitted text with the suggestion the question carried.
 */
export function answerProvenance(answer: string, suggestion: string | undefined): AnswerProvenance {
  if (!suggestion || normalised(suggestion).length === 0) return "typed";
  return normalised(answer) === normalised(suggestion) ? "suggested" : "edited";
}

// ── Pure helpers ────────────────────────────────────────────────────────

/**
 * A per-answer cap for the PUBLISHED copy. Generous enough that a real answer is
 * never touched; it exists so a pathological paste cannot blow past GitHub's
 * issue-body limit and take the whole publish with it. Truncation is announced
 * in the rendered text — a silently shortened answer is the very defect this
 * issue is about.
 */
export const MAX_PUBLISHED_ANSWER = 4000;

const TRUNCATION_NOTE = " …[answer truncated in the published body]";

/**
 * Neutralise text before embedding it in a markdown body that becomes a GitHub
 * issue. The answer is user-authored, but it is *rendered into an artifact* —
 * stripping backticks and angle brackets stops it opening a code fence or an
 * HTML tag, and collapsing whitespace keeps it inside its bullet.
 */
export function sanitizeClarificationText(text: string | null | undefined): string {
  if (!text) return "";
  const cleaned = text.replace(/[`<>]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > MAX_PUBLISHED_ANSWER
    ? cleaned.slice(0, MAX_PUBLISHED_ANSWER).trim() + TRUNCATION_NOTE
    : cleaned;
}

/**
 * Every non-blank answer across every round, newest write per question id.
 *
 * Reads `question.answer` (stamped onto the question by #1104's finding-C fix)
 * and falls back to the round's `answers[]` for rounds persisted before that
 * fix — the same dual read the UI transcript performs, so the artifact and the
 * screen can never disagree about what was answered.
 */
export function collectAnsweredQuestions(
  state: ClarificationState | undefined | null,
): AnsweredQuestion[] {
  if (!state) return [];
  const byQuestionId = new Map<string, AnsweredQuestion>();
  for (const round of state.rounds ?? []) {
    const submitted = new Map((round.answers ?? []).map((a) => [a.questionId, a.answer]));
    for (const q of round.questions ?? []) {
      const answer = (q.answer ?? submitted.get(q.id) ?? "").trim();
      if (answer.length === 0) continue;
      byQuestionId.set(q.id, {
        questionId: q.id,
        requirementId: q.requirementId ?? "",
        question: q.question,
        answer,
        provenance: answerProvenance(answer, q.groundedAnswer),
      });
    }
  }
  return [...byQuestionId.values()];
}

/**
 * Issue #1000 — whether a person has answered any clarifying question for the
 * analysis. Synthesis asks before it calls the extracted requirements
 * "clarified". A failed read answers `false`: the honest default, and the
 * label is not worth failing synthesis over.
 */
export async function hasAnsweredClarification(analysisId: string): Promise<boolean> {
  try {
    return collectAnsweredQuestions(await readDialogState(analysisId)).length > 0;
  } catch (err) {
    log.warn("Could not read the clarification dialog; treating it as unanswered", {
      analysisId,
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Words that carry no discriminating signal when matching a requirement title
 * against a requirement body. Deliberately small: over-stripping makes two
 * unrelated requirements look alike, which is worse than a missed match (a
 * missed match is reported to the user; a wrong match is not).
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "must",
  "should",
  "shall",
  "when",
  "then",
  "than",
  "are",
  "was",
  "were",
  "will",
  "can",
  "not",
  "all",
  "any",
  "its",
  "system",
  "user",
  "users",
  "requirement",
  "requirements",
]);

/**
 * Lowercased, de-noised content tokens (length ≥ 3, non-stopword), with a
 * trailing plural "s" folded away. The fold is crude on purpose: it is applied
 * identically to both sides of the comparison, and without it a title saying
 * "price" would fail to match a body saying "prices" — a false NON-match, which
 * for this feature means silently dropping the user's answer.
 */
export function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    const stem = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    if (STOPWORDS.has(stem)) continue;
    out.add(stem);
  }
  return out;
}

/** Containment of `needle` in `haystack`: |A ∩ B| / |A|, and 0 for an empty A. */
export function containmentScore(needle: Set<string>, haystack: Set<string>): number {
  if (needle.size === 0) return 0;
  let hits = 0;
  for (const t of needle) if (haystack.has(t)) hits++;
  return hits / needle.size;
}

/**
 * How much of a structured requirement's title must appear in a synthesized
 * requirement before we call them the same requirement. Containment (not
 * Jaccard) because the synthesized body is far longer than the title, so a
 * symmetric measure would reject every true match.
 */
export const ATTRIBUTION_THRESHOLD = 0.5;

export interface AttributionResult {
  /** Persisted requirement row id → the answers to write onto it. */
  byRequirementId: Map<string, AnsweredQuestion[]>;
  /** Answers whose requirement could not be identified among the rows. */
  unattributed: AnsweredQuestion[];
}

/** Case- and whitespace-insensitive title, for the exact-title tier. */
function titleKey(title: string): string {
  return normalised(title).toLowerCase();
}

/**
 * Issue #1031 — where the persisted rows came from, which decides how strictly
 * they are matched to structured requirements.
 *
 * - `promoted`: the analysis went through the approval checkpoint, so each row
 *   was written from exactly one approved structured requirement (#730) — one
 *   row per requirement, one requirement per row. A rejected requirement has no
 *   row, and must not borrow its neighbour's.
 * - `synthesized`: no approval requests; the rows are synthesis output, and one
 *   row can legitimately cover several structured requirements, so several may
 *   map onto it.
 */
export type RowOrigin = "promoted" | "synthesized";

/**
 * A candidate pairing of a structured requirement (left) with a persisted row
 * (right). Its score is a tuple of tiers, compared best first with
 * {@link compareTiersDescending}:
 *   0. exact — 1 when the row's title IS the structured title (promotion copies it, #730);
 *   1. description — 1 when, on top of an exact title, the row's body (less our
 *      generated block) IS the structured description. Promotion copies that
 *      too, so it tells two identically titled requirements apart. Clarify may
 *      rewrite the description later, so it only ever breaks a tie inside the
 *      exact tier;
 *   2. containment of the structured title's tokens in the row's title + body;
 *   3. containment of the structured title's tokens in the row's title alone.
 */
export type RowCandidate = OneToOneCandidate<string, string, number[]>;

function buildCandidates(
  structured: readonly StructuredRequirement[],
  rows: ReadonlyArray<{ id: string; title: string; body: string }>,
): RowCandidate[] {
  const rowFeatures = rows.map((r) => ({
    id: r.id,
    titleKey: titleKey(r.title),
    bodyKey: normalised(stripClarificationBlock(r.body ?? "")),
    titleTokens: significantTokens(r.title),
    tokens: significantTokens(`${r.title} ${r.body}`),
  }));
  const candidates: RowCandidate[] = [];
  for (const req of structured) {
    const key = titleKey(req.title);
    const descriptionKey = normalised(req.description ?? "");
    const needle = significantTokens(req.title);
    for (const row of rowFeatures) {
      const exact = key.length > 0 && key === row.titleKey ? 1 : 0;
      const score = containmentScore(needle, row.tokens);
      // An exact title is the strongest evidence there is, so it does not also
      // have to clear the token threshold (a title of short words has none).
      if (exact === 0 && score < ATTRIBUTION_THRESHOLD) continue;
      const description =
        exact === 1 && descriptionKey.length > 0 && descriptionKey === row.bodyKey ? 1 : 0;
      candidates.push({
        left: req.id,
        right: row.id,
        score: [exact, description, score, containmentScore(needle, row.titleTokens)],
      });
    }
  }
  return candidates;
}

/**
 * Issue #1031 — the largest connected component of one level's candidates
 * that the strict "in every maximum matching" proof is run on.
 *
 * Unlike synthesis output (capped at 100 items), nothing caps an analysis's
 * persisted requirement rows or its structured list, and the proof costs about
 * (matched edges × V·E) per component — a complete 300 × 300 level takes
 * seconds. Above this many edges the component is refused outright, which is
 * always safe here: an answer reported as not applied, never a guess. A real
 * component of this size means hundreds of requirements level with each other,
 * which no title match could separate anyway.
 */
export const MAX_ATTRIBUTION_PROOF_EDGES = 2_500;

/**
 * Promoted rows — one row per requirement and one requirement per row, by the
 * rule #1033's promotion fallback shares ({@link matchOneToOneRefusingTies}):
 * at each level a pair is taken only if it is in every maximum matching of
 * that level's candidates; every other requirement or row with a candidate
 * there is refused and takes nothing weaker later. Exported so the shared tie
 * table (`ONE_TO_ONE_TIE_CASES`) runs against exactly this resolution.
 */
export function resolvePromotedCandidates(
  candidates: readonly RowCandidate[],
): OneToOneResult<string, string> {
  return matchOneToOneRefusingTies(candidates, {
    compare: compareTiersDescending,
    maxComponentEdges: MAX_ATTRIBUTION_PROOF_EDGES,
  });
}

/**
 * Synthesized rows — MANY-TO-ONE by design, and so deliberately outside the
 * one-to-one helper: synthesis may consolidate several structured requirements
 * into one row, and each of them belongs on it. Each requirement independently
 * takes its own best row when that best is unique; a level best is refused.
 */
function resolveSynthesizedCandidates(candidates: readonly RowCandidate[]): Map<string, string> {
  const byLeft = new Map<string, RowCandidate[]>();
  for (const c of candidates) byLeft.set(c.left, [...(byLeft.get(c.left) ?? []), c]);
  const matched = new Map<string, string>();
  for (const [left, list] of byLeft) {
    const sorted = [...list].sort((a, b) => compareTiersDescending(a.score, b.score));
    const best = sorted.filter((c) => compareTiersDescending(sorted[0]!.score, c.score) === 0);
    if (best.length === 1) matched.set(left, best[0]!.right);
  }
  return matched;
}

/**
 * Issue #1031 — decide which persisted row IS each structured requirement.
 *
 * The old per-answer loop took the first row with the highest title-in-body
 * score. Two adjacent requirements routinely tie — "Mark all items up to here
 * as read" explains itself as "every entry OLDER than this one", which contains
 * every word of its neighbour "Mark all as read older than X" — and the tie went
 * to whichever row came first. So the answers followed a position, not the
 * requirement the question was asked about.
 *
 * The match is made once for EVERY structured requirement, answered or not, so
 * a row that is one requirement's cannot be handed to its neighbour. A tie the
 * tiers cannot settle is refused: a missed match is reported to the user, a
 * wrong one is not. Row and question order play no part.
 */
function matchStructuredToRows(
  structured: readonly StructuredRequirement[],
  rows: ReadonlyArray<{ id: string; title: string; body: string }>,
  origin: RowOrigin,
): Map<string, string> {
  const candidates = buildCandidates(structured, rows);
  return origin === "synthesized"
    ? resolveSynthesizedCandidates(candidates)
    : resolvePromotedCandidates(candidates).matches;
}

/**
 * Attribute answers to persisted requirement rows.
 *
 * There is no id spine between the two representations: the clarify question
 * names a `StructuredRequirement` id (`REQ-3`), while the persisted rows carry
 * cuid2 ids. So the question's requirement id picks the structured requirement,
 * and {@link matchStructuredToRows} finds that requirement's row by its TITLE —
 * the one field the clarify resolution pass does not rewrite. `rowOrigin`
 * defaults to the strict `promoted` matching.
 */
export function attributeAnswers(input: {
  answered: AnsweredQuestion[];
  structured: StructuredRequirement[] | undefined;
  requirements: ReadonlyArray<{ id: string; title: string; body: string }>;
  rowOrigin?: RowOrigin;
}): AttributionResult {
  const byRequirementId = new Map<string, AnsweredQuestion[]>();
  const unattributed: AnsweredQuestion[] = [];

  const rowByStructuredId = matchStructuredToRows(
    input.structured ?? [],
    input.requirements,
    input.rowOrigin ?? "promoted",
  );

  // Group first so one match decision covers every answer about the same
  // requirement — per-answer matching would let two answers to the same
  // requirement land on different rows.
  const grouped = new Map<string, AnsweredQuestion[]>();
  for (const a of input.answered) {
    const key = a.requirementId || `__unknown__:${a.questionId}`;
    const list = grouped.get(key);
    if (list) list.push(a);
    else grouped.set(key, [a]);
  }

  for (const [key, answers] of grouped) {
    const bestId = rowByStructuredId.get(key);
    if (bestId === undefined) {
      unattributed.push(...answers);
      continue;
    }
    const existing = byRequirementId.get(bestId);
    if (existing) existing.push(...answers);
    else byRequirementId.set(bestId, [...answers]);
  }

  return { byRequirementId, unattributed };
}

// ── Body rendering ──────────────────────────────────────────────────────

/** Markers delimiting the generated block so re-runs replace, never stack. */
export const CLARIFICATIONS_START = "<!-- metis:clarifications:start -->";
export const CLARIFICATIONS_END = "<!-- metis:clarifications:end -->";

export const CLARIFICATIONS_HEADING = "## Clarifications";

/**
 * Issue #1000 — the preamble no longer says every answer came from the
 * requester: an unedited METIS suggestion was being attributed to them. Each
 * answer now carries its own provenance tag instead.
 */
const CLARIFICATIONS_PREAMBLE =
  "_Answers recorded during METIS clarification, verbatim. Each says who wrote it._";

/** Issue #1000 — the tag after each answer, saying who wrote it. */
export const PROVENANCE_TAGS: Record<AnswerProvenance, string> = {
  typed: "_(typed by the requester)_",
  edited: "_(METIS suggestion, edited by the requester)_",
  suggested: "_(METIS suggestion, accepted unchanged)_",
};

/**
 * Render the block for one requirement's answers (empty string for none).
 * `flagCriteria` adds the #1000 line asking for the acceptance criteria to be
 * checked against the answers.
 */
export function renderClarificationBlock(
  answers: ReadonlyArray<AnsweredQuestion>,
  flagCriteria = false,
): string {
  const usable = answers
    .map((a) => ({
      question: sanitizeClarificationText(a.question),
      answer: sanitizeClarificationText(a.answer),
      tag: PROVENANCE_TAGS[a.provenance],
    }))
    .filter((a) => a.answer.length > 0);
  if (usable.length === 0) return "";
  return [
    CLARIFICATIONS_START,
    CLARIFICATIONS_HEADING,
    "",
    CLARIFICATIONS_PREAMBLE,
    "",
    ...(flagCriteria ? [CRITERIA_FLAG_LINE, ""] : []),
    ...usable.map(
      (a) =>
        `- **Q:** ${a.question || "(question text unavailable)"}\n  **A:** ${a.answer} ${a.tag}`,
    ),
    CLARIFICATIONS_END,
  ].join("\n");
}

/**
 * Where the generated block sits in a body (CRLF or LF). One rule (#1162), no recovery:
 *
 * - `none` — no METIS clarification marker and no `## Clarifications` heading
 *   line: a fresh block is appended.
 * - `block` — exactly one START, then exactly one END after it: `[from, to)`
 *   is the block, and it is replaced.
 * - `malformed` — anything else: a lone START or END, two blocks, markers out
 *   of order, or a heading with no markers. The analyst has edited the block,
 *   and every attempt to guess which lines are still METIS's lost or
 *   duplicated their text, so the body is left exactly as it is.
 *
 * Markers are found with the shared pattern `stripMetisMarkers` hides them
 * with, so a whitespace variant (`<!--metis:clarifications:end-->`) counts.
 * Offsets are into the body as given.
 */
type BlockLocation =
  | { kind: "none" }
  | { kind: "block"; from: number; to: number; startLength: number; endLength: number }
  | { kind: "malformed" };

const START_NAME = "clarifications:start";
const END_NAME = "clarifications:end";

function locateClarificationBlock(body: string): BlockLocation {
  const markers = findMetisMarkers(body).filter(
    (m) => m.name === START_NAME || m.name === END_NAME,
  );
  if (markers.length === 0) {
    // CRLF-safe: `trim` drops the `\r` a CRLF line leaves behind.
    const hasHeading = body.split("\n").some((line) => line.trim() === CLARIFICATIONS_HEADING);
    return hasHeading ? { kind: "malformed" } : { kind: "none" };
  }
  const [start, end] = markers;
  if (markers.length === 2 && start.name === START_NAME && end.name === END_NAME) {
    return {
      kind: "block",
      from: start.index,
      to: end.index + end.length,
      startLength: start.length,
      endLength: end.length,
    };
  }
  return { kind: "malformed" };
}

function normalizeNewlines(body: string): string {
  return body.replace(/\r\n/g, "\n");
}

/**
 * Remove a previously generated block (and its surrounding blank lines). A
 * malformed block is left as it is.
 */
export function stripClarificationBlock(body: string): string {
  const at = locateClarificationBlock(body);
  if (at.kind !== "block") return body;
  return (body.slice(0, at.from) + body.slice(at.to)).replace(/\s+$/, "");
}

/** The outcome of {@link planClarificationBlock}. */
export interface ClarificationBlockPlan {
  body: string;
  /** #1162 — the block was edited out of shape; `body` is the input, untouched. */
  malformed: boolean;
}

/**
 * Replace (or add, or remove) the clarifications block on a requirement body.
 *
 * Issue #1000 — when the requirement has acceptance criteria, the block flags
 * them for checking whenever the answers in it change. The flag survives a
 * re-run with the same answers, and goes once someone edits the criteria
 * (`clearCriteriaFlag`, called from the requirement version service) — a re-run
 * with unchanged answers does not bring it back.
 */
export function applyClarificationBlock(
  body: string,
  answers: ReadonlyArray<AnsweredQuestion>,
  opts: { hasAcceptanceCriteria?: boolean } = {},
): string {
  return planClarificationBlock(body, answers, opts).body;
}

/**
 * {@link applyClarificationBlock}, saying whether the block was malformed
 * (#1162). A malformed body is returned exactly as given: the caller writes
 * nothing and reports the answers as not applied.
 */
export function planClarificationBlock(
  body: string,
  answers: ReadonlyArray<AnsweredQuestion>,
  opts: { hasAcceptanceCriteria?: boolean } = {},
): ClarificationBlockPlan {
  // #1162 — every rewrite mints a version and stales a review pinned at the
  // old one, so the body is touched only where the answers changed: the block
  // is replaced IN PLACE, in the body's own line endings, and an unchanged
  // block leaves the body byte-for-byte as stored.
  const source = body ?? "";
  const at = locateClarificationBlock(source);
  if (at.kind === "malformed") return { body: source, malformed: true };
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const unflagged = renderClarificationBlock(answers);

  if (at.kind === "none") {
    if (unflagged.length === 0) return { body: source, malformed: false };
    const flagged = opts.hasAcceptanceCriteria === true;
    const block = withEol(renderClarificationBlock(answers, flagged), eol);
    const base = source.replace(/\s+$/, "");
    return { body: base.length > 0 ? `${base}${eol}${eol}${block}` : block, malformed: false };
  }

  const before = source.slice(0, at.from);
  const after = source.slice(at.to);
  if (unflagged.length === 0) {
    // No answers left: remove the block and the blank lines that framed it —
    // whole blank lines only (#1225): the indentation of the analyst's next
    // line (an indented code block) and a trailing two-space hard break stay.
    // Only the marker lines themselves are trimmed where the block was cut.
    const head = withoutTrailingBlankLines(before);
    const tail = withoutLeadingBlankLines(after);
    return {
      body: head.length > 0 && tail.length > 0 ? `${head}${eol}${eol}${tail}` : head || tail,
      malformed: false,
    };
  }
  // #1225 — compare with the markers in their canonical form (start, end and
  // the criteria flag), so a block whose markers are a whitespace variant but
  // whose answers are unchanged is a no-op.
  const previous = canonicalizeCriteriaFlag(
    normalizeNewlines(
      CLARIFICATIONS_START +
        source.slice(at.from + at.startLength, at.to - at.endLength) +
        CLARIFICATIONS_END,
    ),
  );
  const answersChanged = clearCriteriaFlag(previous) !== unflagged;
  const flag = opts.hasAcceptanceCriteria === true && (answersChanged || hasCriteriaFlag(previous));
  const block = flag ? renderClarificationBlock(answers, true) : unflagged;
  if (block === previous) return { body: source, malformed: false };
  return { body: `${before}${withEol(block, eol)}${after}`, malformed: false };
}

/**
 * The text before a removed block, less the whole blank lines that framed it
 * (#1225). The last line is what preceded the start marker on its own line, so
 * its trailing whitespace goes; trailing spaces on any earlier line — a
 * Markdown hard break — are kept.
 */
function withoutTrailingBlankLines(text: string): string {
  const lines = text.split("\n");
  lines[lines.length - 1] = lines[lines.length - 1].trimEnd();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const kept = lines.join("\n");
  // The newline that ended the last kept line went with the blank lines; its
  // CR goes too.
  return kept.endsWith("\r") ? kept.slice(0, -1) : kept;
}

/**
 * The text after a removed block, less the whole blank lines that framed it
 * (#1225). The first line is the rest of the end-marker line, so its leading
 * whitespace goes — left in, four spaces would make text there an indented
 * code block. Every later line keeps its indentation, so the analyst's own
 * indented code block stays one.
 */
function withoutLeadingBlankLines(text: string): string {
  const lines = text.split("\n");
  lines[0] = lines[0].trimStart();
  let first = 0;
  while (first < lines.length && lines[first].trim() === "") first++;
  return lines.slice(first).join("\n");
}

/** A rendered (LF) block in the line endings of the body it goes into. */
function withEol(block: string, eol: string): string {
  return eol === "\n" ? block : block.replace(/\n/g, eol);
}

// ── The DB pass ─────────────────────────────────────────────────────────

/** Issue #979 — longest question text kept in the per-answer accounting. */
export const MAX_OUTCOME_QUESTION = 200;

function shortenQuestion(question: string): string {
  const q = (question ?? "").replace(/\s+/g, " ").trim();
  return q.length > MAX_OUTCOME_QUESTION ? `${q.slice(0, MAX_OUTCOME_QUESTION - 1)}…` : q;
}

/**
 * Issue #1031 — the rows came from the approval checkpoint exactly when the
 * analysis has `requirement` approval requests; that is the same test
 * `promoteApprovedRequirements` uses to choose the reviewed list over synthesis.
 */
async function readRowOrigin(analysisId: string): Promise<RowOrigin> {
  const approval = await prisma.approvalRequest.findFirst({
    where: { analysisId, type: "requirement" },
    select: { id: true },
  });
  return approval ? "promoted" : "synthesized";
}

/**
 * #1162 — why an answer attributed to a requirement was not written: the
 * requirement's clarifications block was edited out of shape (a marker deleted,
 * a second block, a heading with no markers). The body is left untouched until
 * the analyst restores the markers or deletes the block.
 */
export const CLARIFICATION_BLOCK_EDITED = "clarification-block-edited";

/**
 * #1162 — why else an attributed answer was not written this pass: the
 * requirement kept changing under the write (every retry lost to a concurrent
 * edit), or it was deleted. The next pass tries again.
 */
export const CLARIFICATION_WRITE_CONFLICT = "requirement-changed-during-write";
export const CLARIFICATION_REQUIREMENT_DELETED = "requirement-deleted";

/** Why an attributed answer was not written into its requirement. */
export type ClarificationNotAppliedReason =
  | typeof CLARIFICATION_BLOCK_EDITED
  | typeof CLARIFICATION_WRITE_CONFLICT
  | typeof CLARIFICATION_REQUIREMENT_DELETED;

/** #1162 — the reason recorded on the version row an enrichment write appends. */
export const CLARIFICATION_VERSION_REASON = "Clarification answers applied";

/**
 * #1162 — how many times one row's body write re-reads and re-applies after a
 * concurrent edit won the version check. Past this the row is skipped for this
 * pass (the next pass regenerates the block from scratch), never the whole run.
 */
export const CLARIFICATION_WRITE_ATTEMPTS = 3;

interface EnrichmentRow {
  id: string;
  title: string;
  body: string | null;
  acceptanceCriteria: string | null;
  version: number;
}

/**
 * #1162 — write one row's regenerated body through the version history.
 *
 * The write carries the version the body was computed from. If an analyst
 * edited the row in between, the version check fails and the row is re-read
 * and the block re-applied on top of THEIR body: an unversioned write would
 * have silently overwritten the analyst's edit with text computed from the old
 * body. Returns whether the body changed; a row that keeps losing, or is
 * deleted meanwhile, is skipped and logged rather than failing the run. A row
 * whose block the analyst edited out of shape is not written at all. In each
 * of those cases `notApplied` says why, so its answers are reported as not
 * applied rather than counted as written.
 */
async function writeClarifiedBody(
  row: EnrichmentRow,
  answers: ReadonlyArray<AnsweredQuestion>,
  analysisId: string,
): Promise<{ updated: boolean; title: string; notApplied: ClarificationNotAppliedReason | null }> {
  let current: EnrichmentRow | null = row;
  let title = row.title;
  for (let attempt = 1; current; attempt++) {
    title = current.title;
    // #1000 — the criteria are not regenerated from the answers, so flag them.
    const plan = planClarificationBlock(current.body ?? "", answers, {
      hasAcceptanceCriteria: parseAcceptanceCriteria(current.acceptanceCriteria).length > 0,
    });
    if (plan.malformed) {
      log.warn("Clarification block was edited out of shape; requirement left as it is", {
        analysisId,
        requirementId: row.id,
        reason: CLARIFICATION_BLOCK_EDITED,
      });
      return { updated: false, title, notApplied: CLARIFICATION_BLOCK_EDITED };
    }
    const nextBody = plan.body;
    if (nextBody === (current.body ?? "")) return { updated: false, title, notApplied: null };
    try {
      await updateRequirementWithHistory(prisma as unknown as VersionPrismaClient, {
        requirementId: current.id,
        patch: { body: nextBody },
        expectedVersion: current.version,
        actorId: null,
        reason: CLARIFICATION_VERSION_REASON,
      });
      return { updated: true, title, notApplied: null };
    } catch (err) {
      if (!(err instanceof RequirementVersionError)) throw err;
      if (err.code !== "VERSION_CONFLICT" || attempt >= CLARIFICATION_WRITE_ATTEMPTS) {
        log.warn("Clarification answers not written to a requirement this pass", {
          analysisId,
          requirementId: row.id,
          reason: err.code,
          attempts: attempt,
        });
        return {
          updated: false,
          title,
          notApplied:
            err.code === "VERSION_CONFLICT"
              ? CLARIFICATION_WRITE_CONFLICT
              : CLARIFICATION_REQUIREMENT_DELETED,
        };
      }
    }
    current = (await prisma.requirement.findUnique({
      where: { id: row.id, deletedAt: null },
      select: { id: true, title: true, body: true, acceptanceCriteria: true, version: true },
    })) as EnrichmentRow | null;
  }
  // The re-read found the row gone.
  return { updated: false, title, notApplied: CLARIFICATION_REQUIREMENT_DELETED };
}

/**
 * Write every answered clarifying question into the persisted requirement it
 * was asked about, and record what happened to each answer.
 *
 * Best-effort by construction — it is called from the clarify route and from
 * promotion, and neither may fail because enrichment did. A failure logs and
 * returns `null`; the answers stay in the dialog state and the next pass
 * (promotion, or the next submit) re-applies them from scratch.
 *
 * Idempotent: the block is regenerated from the dialog state every time, and a
 * row that no longer has attributed answers has its stale block removed.
 */
export async function applyClarificationsToRequirements(
  analysisId: string,
): Promise<ClarificationApplication | null> {
  try {
    const state = await readDialogState(analysisId);
    const answered = collectAnsweredQuestions(state);
    if (answered.length === 0) return null;

    const structured: StructuredRequirements | null = await getStructuredRequirements(analysisId);
    const rows = await prisma.requirement.findMany({
      where: { analysisId, deletedAt: null },
      select: { id: true, title: true, body: true, acceptanceCriteria: true, version: true },
    });

    const { byRequirementId, unattributed } = attributeAnswers({
      answered,
      structured: structured?.requirements,
      requirements: rows,
      rowOrigin: await readRowOrigin(analysisId),
    });

    let requirementsUpdated = 0;
    const appliedTo = new Map<string, string>();
    // #1162 — answers attributed to a requirement but not written into it.
    const notAppliedAt = new Map<
      string,
      { reason: ClarificationNotAppliedReason; requirementTitle: string }
    >();
    for (const row of rows) {
      const answers = byRequirementId.get(row.id) ?? [];
      // The title is the one the write last read, so an analyst rename made
      // while enrichment was retrying shows in the accounting.
      const written = await writeClarifiedBody(row, answers, analysisId);
      for (const a of answers) {
        if (written.notApplied) {
          notAppliedAt.set(a.questionId, {
            reason: written.notApplied,
            requirementTitle: written.title,
          });
        } else {
          appliedTo.set(a.questionId, written.title);
        }
      }
      if (written.updated) requirementsUpdated++;
    }
    const blockEditedCount = [...notAppliedAt.values()].filter(
      (n) => n.reason === CLARIFICATION_BLOCK_EDITED,
    ).length;

    const application: ClarificationApplication = {
      answeredCount: answered.length,
      appliedCount: answered.length - unattributed.length - notAppliedAt.size,
      unattributedCount: unattributed.length,
      blockEditedCount,
      notWrittenCount: notAppliedAt.size - blockEditedCount,
      requirementsUpdated,
      requirementsAvailable: rows.length > 0,
      updatedAt: new Date().toISOString(),
      answers: answered.map((a) => ({
        questionId: a.questionId,
        question: shortenQuestion(a.question),
        requirementTitle: appliedTo.get(a.questionId) ?? null,
        provenance: a.provenance,
        ...(notAppliedAt.has(a.questionId) ? { notApplied: notAppliedAt.get(a.questionId) } : {}),
      })),
    };
    await persistAnalysisEnhancement(analysisId, { clarificationApplication: application });

    log.info("Applied clarification answers to requirements", {
      analysisId,
      ...application,
    });
    return application;
  } catch (err) {
    log.warn("Clarification enrichment failed (non-fatal)", {
      analysisId,
      error: (err as Error).message,
    });
    return null;
  }
}
