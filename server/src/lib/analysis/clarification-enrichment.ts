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
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { getStructuredRequirements, persistAnalysisEnhancement } from "./analysis-service.js";
import { readDialogState } from "./clarification-dialog-store.js";
import type {
  ClarificationApplication,
  ClarificationState,
  StructuredRequirement,
  StructuredRequirements,
} from "./types/requirements.js";

export type { ClarificationApplication } from "./types/requirements.js";

const log = createChildLogger("clarification-enrichment");

/** One answered clarifying question, resolved to the text actually submitted. */
export interface AnsweredQuestion {
  questionId: string;
  /** The STRUCTURED requirement id the question was asked about (may be ""). */
  requirementId: string;
  question: string;
  answer: string;
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
      });
    }
  }
  return [...byQuestionId.values()];
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

/**
 * Attribute answers to persisted requirement rows.
 *
 * There is no id spine between the two representations: the clarify question
 * names a `StructuredRequirement` id (`REQ-3`), while the persisted rows come
 * from synthesis and carry cuid2 ids and `finding:<id>` labels. So the join is
 * made on the structured requirement's TITLE — the one field the clarify
 * resolution pass does not rewrite (it rewrites `description`).
 */
export function attributeAnswers(input: {
  answered: AnsweredQuestion[];
  structured: StructuredRequirement[] | undefined;
  requirements: ReadonlyArray<{ id: string; title: string; body: string }>;
}): AttributionResult {
  const byRequirementId = new Map<string, AnsweredQuestion[]>();
  const unattributed: AnsweredQuestion[] = [];

  const structuredById = new Map((input.structured ?? []).map((r) => [r.id, r]));
  const rowTokens = input.requirements.map((r) => ({
    id: r.id,
    tokens: significantTokens(`${r.title} ${r.body}`),
  }));

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
    const structured = structuredById.get(key);
    if (!structured) {
      unattributed.push(...answers);
      continue;
    }
    const needle = significantTokens(structured.title);
    let bestId: string | null = null;
    let bestScore = 0;
    for (const row of rowTokens) {
      const score = containmentScore(needle, row.tokens);
      if (score > bestScore) {
        bestScore = score;
        bestId = row.id;
      }
    }
    if (bestId === null || bestScore < ATTRIBUTION_THRESHOLD) {
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

const CLARIFICATIONS_PREAMBLE =
  "_Answered by the requester during METIS clarification and recorded verbatim._";

/** Render the block for one requirement's answers (empty string for none). */
export function renderClarificationBlock(answers: ReadonlyArray<AnsweredQuestion>): string {
  const usable = answers
    .map((a) => ({
      question: sanitizeClarificationText(a.question),
      answer: sanitizeClarificationText(a.answer),
    }))
    .filter((a) => a.answer.length > 0);
  if (usable.length === 0) return "";
  return [
    CLARIFICATIONS_START,
    CLARIFICATIONS_HEADING,
    "",
    CLARIFICATIONS_PREAMBLE,
    "",
    ...usable.map(
      (a) => `- **Q:** ${a.question || "(question text unavailable)"}\n  **A:** ${a.answer}`,
    ),
    CLARIFICATIONS_END,
  ].join("\n");
}

/** Remove a previously generated block (and its surrounding blank lines). */
export function stripClarificationBlock(body: string): string {
  const start = body.indexOf(CLARIFICATIONS_START);
  if (start === -1) return body;
  const end = body.indexOf(CLARIFICATIONS_END, start);
  const after = end === -1 ? body.length : end + CLARIFICATIONS_END.length;
  return (body.slice(0, start) + body.slice(after)).replace(/\s+$/, "");
}

/** Replace (or add, or remove) the clarifications block on a requirement body. */
export function applyClarificationBlock(
  body: string,
  answers: ReadonlyArray<AnsweredQuestion>,
): string {
  const base = stripClarificationBlock(body ?? "");
  const block = renderClarificationBlock(answers);
  if (block.length === 0) return base;
  return base.length > 0 ? `${base}\n\n${block}` : block;
}

// ── The DB pass ─────────────────────────────────────────────────────────

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
      select: { id: true, title: true, body: true },
    });

    const { byRequirementId, unattributed } = attributeAnswers({
      answered,
      structured: structured?.requirements,
      requirements: rows,
    });

    let requirementsUpdated = 0;
    for (const row of rows) {
      const answers = byRequirementId.get(row.id) ?? [];
      const nextBody = applyClarificationBlock(row.body ?? "", answers);
      if (nextBody === (row.body ?? "")) continue;
      await prisma.requirement.update({ where: { id: row.id }, data: { body: nextBody } });
      requirementsUpdated++;
    }

    const application: ClarificationApplication = {
      answeredCount: answered.length,
      appliedCount: answered.length - unattributed.length,
      unattributedCount: unattributed.length,
      requirementsUpdated,
      requirementsAvailable: rows.length > 0,
      updatedAt: new Date().toISOString(),
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
