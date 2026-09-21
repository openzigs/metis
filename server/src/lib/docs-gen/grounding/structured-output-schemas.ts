/**
 * JSON-schema `response_format` payloads for the doc-gen grounding calls (#336).
 *
 * These mirror the SHAPES the claim-extractor and faithfulness-judge already ask
 * for in prose and validate with Zod AFTER parsing (see `claim-extractor.ts`
 * `decompositionSchema` and `faithfulness-judge.ts` `verdictSchema`). Passing the
 * same shape as an OpenAI-compatible `response_format: { type: "json_schema" }`
 * lets a vLLM (xgrammar) / OpenAI runtime constrain decoding so the model cannot
 * emit unparseable structure — raising the local path's literal/reconstruction
 * pass rates without changing the downstream parse/repair path (which still runs
 * unchanged, and is the graceful fallback when a runtime rejects the field).
 *
 * SCOPE: these are threaded ONLY on the LOCAL/vLLM path and ONLY when
 * `DOCS_GEN_LOCAL_STRUCTURED_OUTPUT=1`. See `docsGenTuning` (`structuredOutput`)
 * and the `OpenAICompatibleProvider` graceful-degradation path.
 *
 * NOTE on `strict`: OpenAI strict mode requires `additionalProperties:false` on
 * every object and every property listed in `required`. We author the schemas to
 * satisfy that and set `strict: true`; vLLM currently ignores the field but
 * tolerates it, so the same payload works on both runtimes.
 */
import type { JsonSchemaResponseFormat } from "../../ai/types.js";

/**
 * Schema for {@link ClaimExtractor.decompose} output:
 * `{ claims: [ { claim: string, sourceIds: string[] } ] }`.
 */
export const CLAIM_DECOMPOSITION_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "claim_decomposition",
    description:
      "Atomic claims decomposed from a documentation passage, each with supporting source ids.",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["claims"],
      properties: {
        claims: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["claim", "sourceIds"],
            properties: {
              claim: { type: "string" },
              sourceIds: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

/**
 * Schema for {@link FaithfulnessJudge} batch output:
 * `{ verdicts: [ { claim: string, supported: boolean, sourceIds: string[] } ] }`.
 */
export const FAITHFULNESS_VERDICTS_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "faithfulness_verdicts",
    description: "Per-claim entailment verdicts against the grounding evidence.",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["verdicts"],
      properties: {
        verdicts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["claim", "supported", "sourceIds"],
            properties: {
              claim: { type: "string" },
              supported: { type: "boolean" },
              sourceIds: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};
