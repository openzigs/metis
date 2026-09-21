/**
 * #335 — the LIVE {@link SectionEvaluator} that wires REAL providers + the real
 * {@link FaithfulnessJudge} for the hybrid A/B rollout gate.
 *
 * This is the operator-facing seam: it is NOT exercised in CI (there are no live
 * local/cloud models in CI, so this file is coverage-excluded, like the SSO
 * provider adapters and the Slack receiver). Everything it does — routing,
 * escalation, faithfulness scoring — DELEGATES to the already-tested #333/#334
 * primitives; it never re-implements them.
 *
 * How the two arms map onto the existing routing:
 *   - Arm A "all-sonnet": force hybrid routing OFF so every section resolves to
 *     the single cloud provider (`router.primary`).
 *   - Arm B "local-escalation": hybrid routing ON + judge-gated escalation ON, so
 *     each section is routed by tier (literal/reconstruction → local, narrative →
 *     escalation) and a below-threshold local section is re-run on the cloud
 *     provider per #334.
 *
 * The env flags are set PER ARM around each call, so a single operator process
 * can measure both configurations against the same corpus in one run.
 */
import {
  providerForSection,
  resolvePhase2Router,
  resolveEscalationConfig,
  shouldEscalateSection,
  type Phase2ProviderBundle,
  type Phase2Router,
} from "../../docs-gen/holistic-synthesizer.js";
import { ClaimExtractor } from "../../docs-gen/grounding/claim-extractor.js";
import { FaithfulnessJudge } from "../../docs-gen/grounding/faithfulness-judge.js";
import { scoreFaithfulness } from "../../docs-gen/grounding/citation-validator.js";
import type { GroundingContext } from "../../docs-gen/grounding/grounding-context.js";
import type { AbCorpusSection, EvalArm, SectionEvaluator, SectionEvalOutcome } from "./types.js";

/** A live corpus item carries the prompt + grounding needed to synthesize. */
export interface LiveSectionInput {
  /** The instruction/prompt used to synthesize this section. */
  prompt: string;
  /** The grounding context the faithfulness judge scores against. */
  grounding: GroundingContext;
}

export interface LiveEvaluatorDeps {
  /** Resolve a live corpus section's prompt + grounding by its ids. */
  resolveSection: (sectionId: string) => LiveSectionInput;
  /** Default max tokens for router construction (mirrors synthesizer default). */
  defaultMaxTokens?: number;
}

interface Grounder {
  extractor: ClaimExtractor;
  judge: FaithfulnessJudge;
}

function grounderFor(bundle: Phase2ProviderBundle): Grounder {
  const extractor = new ClaimExtractor({
    provider: bundle.provider,
    model: bundle.tuning.claimModel,
    promptCaching: bundle.supportsCaching,
  });
  const judge = new FaithfulnessJudge({
    provider: bundle.provider,
    model: bundle.tuning.judgeModel,
    charBudget: bundle.factsCharCap,
    promptCaching: bundle.supportsCaching,
  });
  return { extractor, judge };
}

async function generateAndScore(
  bundle: Phase2ProviderBundle,
  section: AbCorpusSection,
  live: LiveSectionInput,
): Promise<{ faithfulness: number | null; tokens: number }> {
  const res = await bundle.provider.chat(
    [
      {
        role: "system",
        content: "You synthesize a documentation section from the provided facts.",
      },
      { role: "user", content: live.prompt },
    ],
    { model: bundle.tuning.phase2Model, maxTokens: 4096 },
  );
  const tokens = res.usage.totalTokens;
  const grounder = grounderFor(bundle);
  const result = await scoreFaithfulness(section.label, res.content.trim(), live.grounding, {
    extractor: grounder.extractor,
    judge: grounder.judge,
  });
  const faithfulness = result.verified && result.totalClaims > 0 ? result.faithfulness : null;
  return { faithfulness, tokens };
}

/**
 * Build a live section evaluator. Reads the #333/#334 env flags PER ARM so both
 * configurations are measured in one operator run. The caller is responsible for
 * having the local + cloud providers actually configured (LOCAL_GEMMA_* +
 * cloud), exactly as a real docs-gen run requires.
 */
export function createLiveSectionEvaluator(deps: LiveEvaluatorDeps): SectionEvaluator {
  const defaultMaxTokens = deps.defaultMaxTokens ?? 8192;

  const withArmEnv = <T>(arm: EvalArm, fn: () => T): T => {
    const prevHybrid = process.env.DOCS_GEN_HYBRID_ROUTING;
    const prevEsc = process.env.DOCS_GEN_JUDGE_ESCALATION;
    if (arm === "all-sonnet") {
      process.env.DOCS_GEN_HYBRID_ROUTING = "0";
      process.env.DOCS_GEN_JUDGE_ESCALATION = "0";
    } else {
      process.env.DOCS_GEN_HYBRID_ROUTING = "1";
      process.env.DOCS_GEN_JUDGE_ESCALATION = "1";
    }
    try {
      return fn();
    } finally {
      restore("DOCS_GEN_HYBRID_ROUTING", prevHybrid);
      restore("DOCS_GEN_JUDGE_ESCALATION", prevEsc);
    }
  };

  return async ({ arm, section }): Promise<SectionEvalOutcome> => {
    const live = deps.resolveSection(section.id);
    const router: Phase2Router = withArmEnv(arm, () => resolvePhase2Router(defaultMaxTokens));
    const escalationConfig = withArmEnv(arm, () => resolveEscalationConfig());

    // Route this section by its tier — reuses the production decision so the A/B
    // path can never diverge from what a real run would do.
    const { bundle } = providerForSection(router, {
      narrative: section.tier === "narrative",
      reconstruction: section.tier === "reconstruction",
    });

    const first = await generateAndScore(bundle, section, live);
    const localTokens = bundle.kind === "local" ? first.tokens : 0;
    let cloudTokens = bundle.kind === "local" ? 0 : first.tokens;
    let faithfulness = first.faithfulness;
    let escalated = false;

    // #334 — judge-gated escalation: re-run a below-threshold LOCAL section on the
    // cloud escalation provider and keep the better score. Uses the exact
    // production gate predicate.
    const threshold = tierThreshold(section);
    // The escalation gate only reads {faithfulness, threshold}; an unverified
    // section (null score) never escalates, matching production.
    const score =
      first.faithfulness == null ? null : { faithfulness: first.faithfulness, threshold };
    if (
      shouldEscalateSection({
        config: escalationConfig,
        router,
        sectionBundle: bundle,
        score,
        escalationsUsed: 0,
      }) &&
      router.hybrid
    ) {
      escalated = true;
      const esc = router.hybrid.escalation;
      const escResult = await generateAndScore(esc, section, live);
      cloudTokens += escResult.tokens;
      const escScore = escResult.faithfulness;
      if (escScore == null || (first.faithfulness != null && escScore >= first.faithfulness)) {
        faithfulness = escScore ?? first.faithfulness;
      }
    }

    return { faithfulness, escalated, localTokens, cloudTokens };
  };
}

function restore(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

function tierThreshold(section: AbCorpusSection): number {
  switch (section.tier) {
    case "narrative":
      return 0.4;
    case "reconstruction":
      return 0.6;
    case "literal":
      return 0.8;
  }
}
