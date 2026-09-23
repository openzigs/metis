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
 * `DOCS_GEN_LOCAL_STRUCTURED_OUTPUT` is `json_schema` (or `1`) — or, for a
 * runtime that ignores `json_schema`, `json_object` (#117). See `docsGenTuning`
 * (`structuredOutput`) and the `OpenAICompatibleProvider` graceful-degradation
 * path.
 *
 * NOTE on `strict`: OpenAI strict mode requires `additionalProperties:false` on
 * every object and every property listed in `required`. We author the schemas to
 * satisfy that and set `strict: true`; vLLM currently ignores the field but
 * tolerates it, so the same payload works on both runtimes.
 */
import type { JsonObjectResponseFormat, JsonSchemaResponseFormat } from "../../ai/types.js";

/**
 * #117 — how the local grounding calls ask for structured output.
 *
 * - `json_schema`: schema-constrained decoding (vLLM/xgrammar, `gemma3:12b`).
 * - `json_object`: plain JSON mode with the shape stated in the prompt, for a
 *   runtime that accepts `json_schema` with HTTP 200 and ignores it
 *   (`laguna-s-2.1` on Ollama 0.34.2 returned a markdown list).
 * - `off`: no `response_format` at all (the default).
 */
export type StructuredOutputMode = "json_schema" | "json_object" | "off";

/**
 * Parse `DOCS_GEN_LOCAL_STRUCTURED_OUTPUT`. The pre-#117 boolean spellings keep
 * their meaning (`1`/`true`/`yes`/`on` → `json_schema`, `0`/`false`/`no`/`off`
 * → `off`); unset, empty or unrecognised is `off`, as it always was.
 */
export function parseStructuredOutputMode(raw: string | undefined): StructuredOutputMode {
  const v = raw?.trim().toLowerCase() ?? "";
  if (v === "json_schema" || /^(1|true|yes|on)$/.test(v)) return "json_schema";
  if (v === "json_object") return "json_object";
  return "off";
}

/** #117 — the `json_object` request: JSON guaranteed, shape carried by the prompt. */
export const JSON_OBJECT_RESPONSE_FORMAT: JsonObjectResponseFormat = { type: "json_object" };

/**
 * #117 — the prompt suffix that states the required shape in `json_object`
 * mode, where the runtime enforces JSON but not the schema.
 */
export function jsonObjectShapeInstruction(format: JsonSchemaResponseFormat): string {
  return (
    "\n\nYour reply MUST be a single JSON object that validates against this JSON Schema:\n" +
    JSON.stringify(format.json_schema.schema)
  );
}

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
