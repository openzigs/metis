/**
 * Epic #194 (C.3) — `score_grounding` AI tool.
 *
 * Read-only tool exposed to agents that wraps {@link scoreGrounding}.
 * Risk: low (no side effects, no external calls beyond the optional
 * judge LLM which is itself rate-limited).
 *
 * Wire-up: registered at server boot via {@link registerScoreGrounding}.
 */
import { z } from "zod";
import {
  scoreGrounding,
  type GroundingScore,
  type JudgeLike,
} from "../../judge/hallucination-scorer.js";
import type { ToolDefinition, ToolResult, ToolContext } from "../types.js";

export const SCORE_GROUNDING_TOOL_NAME = "score_grounding";

export const scoreGroundingSchema = z.object({
  output: z
    .string()
    .min(1)
    .max(64 * 1024),
  sources: z
    .array(
      z
        .string()
        .min(1)
        .max(64 * 1024),
    )
    .min(1)
    .max(64),
  ngramSize: z.number().int().min(2).max(8).optional(),
  maxClaims: z.number().int().min(1).max(32).optional(),
});

export type ScoreGroundingArgs = z.infer<typeof scoreGroundingSchema>;

export interface ScoreGroundingDeps {
  judge?: JudgeLike;
}

export function createScoreGroundingTool(
  deps: ScoreGroundingDeps = {},
): ToolDefinition<typeof scoreGroundingSchema> {
  return {
    name: SCORE_GROUNDING_TOOL_NAME,
    description:
      "Score how well an LLM output is grounded in supplied source chunks. " +
      "Returns groundingScore + hallucinationScore in [0,1]. Read-only.",
    schema: scoreGroundingSchema,
    risk: "low",
    async exec(args: ScoreGroundingArgs, _ctx: ToolContext): Promise<ToolResult> {
      const result: GroundingScore = await scoreGrounding({
        output: args.output,
        sources: args.sources,
        judge: deps.judge,
        ngramSize: args.ngramSize,
        maxClaims: args.maxClaims,
      });
      const summary =
        `grounding=${result.groundingScore.toFixed(2)} ` +
        `hallucination=${result.hallucinationScore.toFixed(2)} ` +
        `(citation=${result.citationOverlap.toFixed(2)}, entailment=${result.entailmentScore.toFixed(2)})`;
      return {
        text: summary,
        data: result,
      };
    },
  };
}

export function registerScoreGrounding(
  registry: {
    register: (t: ToolDefinition) => void;
    unregister: (n: string) => boolean;
  },
  deps: ScoreGroundingDeps = {},
): { registered: boolean } {
  registry.unregister(SCORE_GROUNDING_TOOL_NAME);
  registry.register(createScoreGroundingTool(deps) as unknown as ToolDefinition);
  return { registered: true };
}
