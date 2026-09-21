/**
 * JSON-schema `response_format` payload for the multi-agent analysis specialists.
 *
 * WHY: `runAgent` asked for JSON in prose only and validated with Zod AFTER
 * parsing. On long, table-heavy answers (the `database` specialist against a
 * 641-table Oracle schema) the model intermittently emitted structurally
 * invalid JSON — `Expected ',' or ']' after array element in JSON at position N`
 * with `contentLength` well under the token cap, so it was malformed rather than
 * truncated. Every such run threw away a completed investigation.
 *
 * Passing the shape as an OpenAI-compatible `response_format:
 * { type: "json_schema" }` lets a runtime that supports constrained decoding
 * make that failure mode impossible. Runtimes that reject the field degrade
 * gracefully: the provider raises `StructuredOutputRejectedError` and retries
 * once without it, landing back on the unchanged free-form parse path.
 *
 * This mirrors `agentOutputSchema` / `documentAgentOutputSchema` in
 * `@metis/shared` — Zod remains the authority and still validates the result.
 *
 * FIELDS THE MODEL DOES NOT AUTHOR (`verificationStatus`, `supportPanel`, and
 * #1318's `faithfulness`) are deliberately absent: with
 * `additionalProperties: false` the model physically cannot emit them. That is
 * only ONE of the defences, and only on providers that accept this schema —
 * #1318's `faithfulness` is additionally refused at the storage boundary by
 * `persistAgentResult` unless the server authored it (`server-authored.ts`),
 * which is what covers the plain-Zod path.
 *
 * `verdict`, `requirementId`, and (#1234) `confidence` / `derivation` ARE
 * model-authored (server-gated afterwards) and are present as nullable.
 *
 * NOTE on `strict`: OpenAI strict mode requires `additionalProperties: false` on
 * every object and every property listed in `required`; optionality is expressed
 * as a nullable type. These schemas satisfy that.
 */
import {
  ANALYSIS_AGENT_KEYS,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  MODEL_ASSERTABLE_FINDING_DERIVATIONS,
  REQUIREMENT_VERDICTS,
} from "@metis/shared";
import type { JsonSchemaResponseFormat } from "../ai/types.js";

/** `{ documentId, chunkIndex, ... }` — a retrieved-chunk citation. */
const DOCUMENT_CITATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["documentId", "chunkIndex", "snippet"],
  properties: {
    documentId: { type: "string" },
    chunkIndex: { type: "integer", minimum: 0 },
    snippet: { type: ["string", "null"] },
  },
} as const;

/** `{ filePath, startLine, endLine, ... }` — an Epic #726 code citation. */
const CODE_CITATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["filePath", "startLine", "endLine", "symbolId", "snippet"],
  properties: {
    filePath: { type: "string" },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    symbolId: { type: ["string", "null"] },
    snippet: { type: ["string", "null"] },
  },
} as const;

const FINDING_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "category",
    "severity",
    "title",
    "body",
    "citations",
    "tags",
    "requirementId",
    "verdict",
    "confidence",
    "derivation",
  ],
  properties: {
    category: { type: "string", enum: [...FINDING_CATEGORIES] },
    severity: { type: "string", enum: [...FINDING_SEVERITIES] },
    title: { type: "string", maxLength: 255 },
    body: { type: "string", maxLength: 4096 },
    citations: {
      type: "array",
      maxItems: 20,
      items: { anyOf: [DOCUMENT_CITATION_SCHEMA, CODE_CITATION_SCHEMA] },
    },
    tags: { type: "array", maxItems: 16, items: { type: "string", maxLength: 64 } },
    requirementId: { type: ["string", "null"], maxLength: 128 },
    verdict: { type: ["string", "null"], enum: [...REQUIREMENT_VERDICTS, null] },
    // #1234 — model-authored provenance. `extracted` is absent from the enum on
    // purpose: it implies confidence 1.0 and is a server-side claim only.
    confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
    derivation: {
      type: ["string", "null"],
      enum: [...MODEL_ASSERTABLE_FINDING_DERIVATIONS, null],
    },
  },
} as const;

const BASE_PROPERTIES = {
  agentKey: { type: "string", enum: [...ANALYSIS_AGENT_KEYS] },
  summary: { type: "string", maxLength: 2048 },
  findings: { type: "array", maxItems: 50, items: FINDING_SCHEMA },
  notes: { type: "array", maxItems: 20, items: { type: "string", maxLength: 512 } },
} as const;

const BASE_REQUIRED = ["agentKey", "summary", "findings", "notes"];

/** Shape for every specialist EXCEPT `document`. Mirrors `agentOutputSchema`. */
export const AGENT_OUTPUT_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "analysis_agent_output",
    description: "A single analysis specialist's summary, findings and notes.",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: BASE_REQUIRED,
      properties: BASE_PROPERTIES,
    },
  },
};

/**
 * Shape for the `document` specialist (#750) — the base output PLUS the
 * extracted `requirements` array the code agent needs to leave single-shot mode.
 */
export const DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "document_agent_output",
    description: "The document specialist's summary, findings, notes and extracted requirements.",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: [...BASE_REQUIRED, "requirements"],
      properties: {
        ...BASE_PROPERTIES,
        requirements: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "text"],
            properties: {
              id: { type: "string", maxLength: 128 },
              text: { type: "string", maxLength: 2048 },
            },
          },
        },
      },
    },
  },
};

/** Pick the payload matching the schema `runAgent` will validate against. */
export function responseFormatForAgent(agentKey: string): JsonSchemaResponseFormat {
  return agentKey === "document"
    ? DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT
    : AGENT_OUTPUT_RESPONSE_FORMAT;
}
