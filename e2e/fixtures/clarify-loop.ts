/**
 * Single source of truth for the #235 generative-loop e2e test.
 *
 * Epic #209 (#235) — "ambiguous input → clarifying questions → answers →
 * persisted refined requirement → refinement visible in the regenerated spec".
 *
 * Every value the deterministic record/replay harness (#234) needs lives here
 * so three independent pieces stay in lock-step:
 *
 *   1. `server/scripts/e2e-seed-clarify-loop.ts` — seeds a COMPLETED analysis
 *      with one known specialist finding so the synthesis prompt is fully
 *      determined (no live LLM, no offline-stub-derived prose).
 *   2. `server/scripts/e2e-build-clarify-fixtures.ts` — computes the exact
 *      `fixtureKey()` for each `provider.chat()` call the loop makes and writes
 *      a hand-crafted `ReplayProvider` fixture for each, so replay is
 *      deterministic with NO live API keys.
 *   3. `e2e/tests/clarify-loop.spec.ts` — drives the chain and asserts the
 *      sentinel text below is persisted (Prisma) and surfaces in the
 *      regenerated spec.
 *
 * Why a sentinel string? The clarification *answer* injects a phrase
 * (`REFINEMENT_SENTINEL`) that the resolution fixture folds into the refined
 * requirement description, and the synthesis fixture echoes into a generated
 * requirement body. Asserting on that exact phrase proves the refinement
 * actually flowed through persistence into the regenerated spec — not that an
 * unrelated stub happened to contain matching words.
 */

import type {
  ClarificationAnswer,
  ClarifyingQuestion,
  StructuredRequirement,
  StructuredRequirements,
} from "../../server/src/lib/analysis/types/requirements.js";

// ── Deterministic identifiers ──────────────────────────────────────────────

/**
 * Fixed project name. The synthesis prompt embeds `analysis.project.name`, so
 * the synthesis fixture key depends on it — it MUST be constant (the slug can
 * still be unique per run; only the name feeds the prompt).
 */
export const PROJECT_NAME = "Clarify Loop E2E (#235)";
export const PROJECT_SLUG_PREFIX = "e2e-235-clarify";

/**
 * Fixed project description. The specialist-agent prompt embeds it, so the
 * regenerate specialist chat fixture key depends on it — it MUST match what the
 * spec passes to `POST /api/projects`.
 */
export const PROJECT_DESCRIPTION = "epic-209 #235 generative loop";

/**
 * Pinned model id. Seeded into `Analysis.metadata.model` so the regenerate path
 * passes it directly to both the specialist agent and synthesis, bypassing the
 * dynamic model router. This keeps every replayed chat fixture key deterministic.
 */
export const LOOP_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * The specialist agent regenerate triggers — chosen so it is NOT the seeded
 * `code` agent, so the seeded finding survives `persistAgentResult` (which only
 * replaces the row for the regenerated agent key) and reaches synthesis.
 */
export const REGENERATE_AGENT_KEY = "database" as const;

/** Stable requirement id the clarification dialog operates on. */
export const REQUIREMENT_ID = "REQ-CLARIFY-235";

/**
 * The unique sentinel the user's clarification answer introduces. It is folded
 * into the refined requirement description (resolution fixture) and echoed by
 * the synthesis fixture, so a single grep proves the loop closed end-to-end.
 */
export const REFINEMENT_SENTINEL = "OAuth2 PKCE with mandatory MFA (clarified-235)";

/** The ambiguity field resolved by answering the clarifying question. */
export const AMBIGUITY_FIELD = "authentication-method";

// ── Ambiguous starting requirement (the "ambiguous input") ──────────────────

export const AMBIGUOUS_REQUIREMENT: StructuredRequirement = {
  id: REQUIREMENT_ID,
  title: "Secure user sign-in",
  description: "Users must be able to sign in securely to the portal.",
  type: "functional",
  stakeholders: ["end-user", "security"],
  priority: "must-have",
  ambiguities: [
    {
      field: AMBIGUITY_FIELD,
      description:
        "The requirement does not state which authentication mechanism or factors are required.",
      suggestedQuestion: "Which authentication method and factors must sign-in use?",
    },
  ],
  evidenceNeeds: [],
  rawSource: "Users must be able to sign in securely.",
};

export const START_REQUIREMENTS: StructuredRequirements = {
  requirements: [AMBIGUOUS_REQUIREMENT],
  totalAmbiguities: 1,
  totalEvidenceNeeds: 0,
};

// ── Round-1 question the questions fixture must return ──────────────────────
//
// The dialog generates a stable question id (randomUUID) at runtime, so the
// spec reads the real id back from the round state and answers it. The fixture
// only fixes the *question text* and its requirement/field linkage.

export const CLARIFYING_QUESTION: Omit<ClarifyingQuestion, "id"> = {
  requirementId: REQUIREMENT_ID,
  ambiguityField: AMBIGUITY_FIELD,
  question: "Which authentication method and factors must the secure sign-in use?",
  context: "The requirement says 'securely' without naming a mechanism or factor count.",
};

/** The JSON the questions `chat()` fixture returns (parsed by `parseQuestions`). */
export const QUESTIONS_RESPONSE_JSON = JSON.stringify({
  questions: [
    {
      requirementId: CLARIFYING_QUESTION.requirementId,
      ambiguityField: CLARIFYING_QUESTION.ambiguityField,
      question: CLARIFYING_QUESTION.question,
      context: CLARIFYING_QUESTION.context,
    },
  ],
});

// ── The user's answer (drives resolution) ───────────────────────────────────

export const ANSWER_TEXT = `Use ${REFINEMENT_SENTINEL}.`;

export function buildAnswer(questionId: string): ClarificationAnswer {
  return { questionId, answer: ANSWER_TEXT };
}

/**
 * The refined description the resolution `chat()` fixture returns. It embeds
 * the sentinel so persistence + spec assertions can grep for it. `resolveAmbiguities`
 * writes this verbatim into the requirement's `description` and pushes the
 * resolved field into `state.resolvedAmbiguities`.
 */
export const REFINED_DESCRIPTION = `Users must sign in using ${REFINEMENT_SENTINEL}. All sign-in flows require the MFA challenge before a session is issued.`;

/** The JSON the resolution `chat()` fixture returns (parsed by `parseResolution`). */
export const RESOLUTION_RESPONSE_JSON = JSON.stringify({
  resolvedFields: [AMBIGUITY_FIELD],
  updatedDescription: REFINED_DESCRIPTION,
  remainingUncertainty: 0,
});

// ── Seeded specialist finding (makes the synthesis prompt deterministic) ─────
//
// A single `code`-agent finding is seeded into a COMPLETED analysis. With
// exactly one agent result + one finding, `readFlattenedFindings` returns a
// one-row table whose `formatFindingsTable` output is fully predictable, so the
// synthesis fixture key is stable.

export interface SeedFinding {
  agentKey: "code";
  category: string;
  severity: string;
  title: string;
  body: string;
  tags: string[];
}

export const SEED_FINDING: SeedFinding = {
  agentKey: "code",
  category: "architecture",
  severity: "high",
  title: "Sign-in lacks an explicit authentication mechanism",
  body: "The auth module exposes signIn() but does not enforce a specific method or second factor.",
  tags: ["auth", "gap"],
};

/**
 * The JSON the regenerated specialist (`REGENERATE_AGENT_KEY`) `chat()` fixture
 * returns. Empty findings: the regenerate exists only to re-trigger synthesis,
 * and emitting no new findings keeps the synthesis findings table (and thus its
 * fixture key) equal to the single seeded `code` finding. Conforms to
 * `agentOutputSchema`.
 */
export const SPECIALIST_RESPONSE_JSON = JSON.stringify({
  agentKey: REGENERATE_AGENT_KEY,
  summary: "No additional data-model findings (e2e #235 regenerate trigger).",
  findings: [],
  notes: [],
});

/**
 * The synthesis spec the synthesis `chat()` fixture returns. The first
 * requirement body echoes the sentinel, proving the clarification-refined
 * requirement reached the regenerated spec. Conforms to `synthesisOutputSchema`.
 */
export const SYNTHESIS_RESPONSE_JSON = JSON.stringify({
  summary: `Synthesised sign-in requirement incorporating the clarified ${AMBIGUITY_FIELD}.`,
  requirements: [
    {
      type: "feature",
      title: "Secure user sign-in",
      body: `Sign-in MUST use ${REFINEMENT_SENTINEL}; the MFA challenge is mandatory before issuing a session.`,
      priority: "high",
      labels: ["auth", "security"],
      evidenceFindingIndexes: [0],
    },
  ],
});
