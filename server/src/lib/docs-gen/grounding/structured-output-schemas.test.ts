/**
 * Guards the JSON-schema `response_format` payloads (#336) for the doc-gen
 * grounding calls: they must be OpenAI-strict-mode valid (every object has
 * `additionalProperties:false` and lists every property in `required`) and must
 * match the shapes the extractor/judge already parse + Zod-validate downstream.
 */
import { describe, expect, it } from "vitest";
import {
  CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
  FAITHFULNESS_VERDICTS_RESPONSE_FORMAT,
} from "./structured-output-schemas.js";

type JsonObj = Record<string, unknown>;

/**
 * Recursively assert every `type:"object"` node in a JSON Schema satisfies
 * OpenAI strict mode: `additionalProperties:false` and a `required` array that
 * lists EVERY declared property.
 */
function assertStrict(node: unknown): void {
  if (node === null || typeof node !== "object") return;
  const obj = node as JsonObj;
  if (obj.type === "object") {
    expect(obj.additionalProperties).toBe(false);
    const props = Object.keys((obj.properties as JsonObj | undefined) ?? {});
    const required = (obj.required as string[] | undefined) ?? [];
    expect([...required].sort()).toEqual([...props].sort());
  }
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) value.forEach(assertStrict);
    else assertStrict(value);
  }
}

describe("structured-output response_format schemas (#336)", () => {
  it("both are valid json_schema response_format payloads with a name + strict flag", () => {
    for (const rf of [CLAIM_DECOMPOSITION_RESPONSE_FORMAT, FAITHFULNESS_VERDICTS_RESPONSE_FORMAT]) {
      expect(rf.type).toBe("json_schema");
      expect(rf.json_schema.name).toMatch(/\w+/);
      expect(rf.json_schema.strict).toBe(true);
      expect(rf.json_schema.schema.type).toBe("object");
    }
  });

  it("claim-decomposition schema is strict-mode valid and shapes { claims: [{claim, sourceIds}] }", () => {
    assertStrict(CLAIM_DECOMPOSITION_RESPONSE_FORMAT.json_schema.schema);
    const schema = CLAIM_DECOMPOSITION_RESPONSE_FORMAT.json_schema.schema as JsonObj;
    const claims = (schema.properties as JsonObj).claims as JsonObj;
    const item = claims.items as JsonObj;
    expect(Object.keys(item.properties as JsonObj).sort()).toEqual(["claim", "sourceIds"]);
  });

  it("faithfulness-verdicts schema is strict-mode valid and shapes { verdicts: [{claim, supported, sourceIds}] }", () => {
    assertStrict(FAITHFULNESS_VERDICTS_RESPONSE_FORMAT.json_schema.schema);
    const schema = FAITHFULNESS_VERDICTS_RESPONSE_FORMAT.json_schema.schema as JsonObj;
    const verdicts = (schema.properties as JsonObj).verdicts as JsonObj;
    const item = verdicts.items as JsonObj;
    expect(Object.keys(item.properties as JsonObj).sort()).toEqual([
      "claim",
      "sourceIds",
      "supported",
    ]);
    expect(((item.properties as JsonObj).supported as JsonObj).type).toBe("boolean");
  });
});
