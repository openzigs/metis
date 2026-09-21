/**
 * #1152 follow-up — the analysis specialists' `response_format` payloads must
 * stay strict-mode-valid AND stay in lockstep with the Zod schemas in
 * `@metis/shared` that actually validate the parsed output. A drift between the
 * two is silent: the runtime constrains the model to a shape Zod then rejects.
 */
import { describe, expect, it } from "vitest";
import {
  ANALYSIS_AGENT_KEYS,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  agentOutputSchema,
  documentAgentOutputSchema,
} from "@metis/shared";
import {
  AGENT_OUTPUT_RESPONSE_FORMAT,
  DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT,
  responseFormatForAgent,
} from "./structured-output-schemas.js";

/**
 * OpenAI strict mode: every object needs `additionalProperties: false` and must
 * list EVERY declared property in `required`. Walk the whole tree, not just the
 * root — a nested object that violates this is rejected at request time.
 */
function assertStrict(node: unknown, path = "$"): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (obj.type === "object") {
    expect(obj.additionalProperties, `${path}.additionalProperties`).toBe(false);
    const props = Object.keys((obj.properties ?? {}) as Record<string, unknown>);
    expect(new Set(obj.required as string[]), `${path}.required`).toEqual(new Set(props));
  }
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) value.forEach((v, i) => assertStrict(v, `${path}.${key}[${i}]`));
    else assertStrict(value, `${path}.${key}`);
  }
}

describe("analysis structured-output schemas", () => {
  it("are strict-mode valid at every level of nesting", () => {
    assertStrict(AGENT_OUTPUT_RESPONSE_FORMAT.json_schema.schema, "agent");
    assertStrict(DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT.json_schema.schema, "document");
  });

  it("declares strict mode and a unique schema name per shape", () => {
    expect(AGENT_OUTPUT_RESPONSE_FORMAT.json_schema.strict).toBe(true);
    expect(DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT.json_schema.strict).toBe(true);
    expect(AGENT_OUTPUT_RESPONSE_FORMAT.json_schema.name).not.toBe(
      DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT.json_schema.name,
    );
  });

  it("routes the document agent to the requirements-bearing shape and others to the base", () => {
    expect(responseFormatForAgent("document")).toBe(DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT);
    for (const key of ["code", "database", "web"]) {
      expect(responseFormatForAgent(key)).toBe(AGENT_OUTPUT_RESPONSE_FORMAT);
    }
  });

  it("keeps enums in lockstep with the shared constants", () => {
    const read = (node: unknown, ...keys: string[]): Record<string, unknown> =>
      keys.reduce<Record<string, unknown>>(
        (acc, k) => acc[k] as Record<string, unknown>,
        node as Record<string, unknown>,
      );
    const root = AGENT_OUTPUT_RESPONSE_FORMAT.json_schema.schema;
    expect(read(root, "properties", "agentKey").enum).toEqual([...ANALYSIS_AGENT_KEYS]);
    const finding = read(root, "properties", "findings", "items", "properties");
    expect((finding.category as Record<string, unknown>).enum).toEqual([...FINDING_CATEGORIES]);
    expect((finding.severity as Record<string, unknown>).enum).toEqual([...FINDING_SEVERITIES]);
  });

  it("produces payloads the Zod validators accept", () => {
    const base = {
      agentKey: "database",
      summary: "Schema impact of the Regional Hub job chain.",
      findings: [
        {
          category: FINDING_CATEGORIES[0],
          severity: FINDING_SEVERITIES[0],
          title: "SALESDB.TRANSACTION_JOBS needs a source/sink org column",
          body: "The THEO concept ties Source/Sink Org ID to the Organization entity.",
          citations: [{ documentId: "clabc123456", chunkIndex: 0, snippet: "…" }],
          tags: ["schema"],
          requirementId: null,
          verdict: null,
        },
      ],
      notes: ["Introspection covered 641 tables."],
    };
    expect(() => agentOutputSchema.parse(base)).not.toThrow();
    expect(() =>
      documentAgentOutputSchema.parse({
        ...base,
        agentKey: "document",
        requirements: [{ id: "REQ-001", text: "XDOCK jobs must be ordered." }],
      }),
    ).not.toThrow();
  });
});
