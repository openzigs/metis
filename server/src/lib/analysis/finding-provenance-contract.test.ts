/**
 * Issue #1234 — the finding CONTRACT the model is given.
 *
 * Three defects lived in the prompt itself: no `confidence`/`derivation` field
 * to report into, a bare pipe-delimited category enum with no selection
 * guidance (8 of 8 measured findings came back `architecture`), and a body hint
 * that literally asked for `<one paragraph>` — which is what #1232 had to clamp
 * in the UI.
 */
import { describe, expect, it } from "vitest";
import { FINDING_CATEGORIES, MODEL_ASSERTABLE_FINDING_DERIVATIONS } from "@metis/shared";
import {
  buildAgenticCodePrompt,
  buildDocumentExtractionPrompt,
  buildRequirementGroundedPrompt,
  buildSpecialistPrompt,
} from "./prompts.js";
import {
  AGENT_OUTPUT_RESPONSE_FORMAT,
  DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT,
} from "./structured-output-schemas.js";

const BASE = {
  projectName: "Acme",
  projectDescription: "desc",
  retrievedContext: "[0] doc.md#0\nsome text",
};

const REQUIREMENTS = [{ id: "REQ-001", text: "The system shall retain jobs for 7 years" }];

/** Every prompt builder that hands a model the findings contract. */
const prompts: Array<[string, string]> = [
  ["specialist", buildSpecialistPrompt({ ...BASE, agentKey: "code" }).systemMessage],
  ["document extraction", buildDocumentExtractionPrompt(BASE).systemMessage],
  [
    "requirement-grounded",
    buildRequirementGroundedPrompt({
      ...BASE,
      requirements: REQUIREMENTS.map((r) => ({ ...r, evidence: "[0] documentId=d chunk=0" })),
    }).systemMessage,
  ],
  ["agentic code", buildAgenticCodePrompt({ ...BASE, requirements: REQUIREMENTS }).systemMessage],
];

describe("finding output contract (#1234)", () => {
  it.each(prompts)("the %s prompt asks for confidence and derivation", (_name, systemMessage) => {
    expect(systemMessage).toContain('"confidence"');
    expect(systemMessage).toContain('"derivation"');
    expect(systemMessage).toContain(MODEL_ASSERTABLE_FINDING_DERIVATIONS.join("|"));
  });

  it.each(prompts)("the %s prompt never offers `extracted` to the model", (_name, msg) => {
    // Not merely absent from the enum — absent from the prompt entirely. Naming
    // the forbidden token, even to forbid it, primes the model to produce it.
    expect(msg).not.toContain("extracted");
  });

  it.each(prompts)("the %s prompt gives per-category selection guidance", (_name, msg) => {
    for (const category of FINDING_CATEGORIES) {
      expect(msg).toContain(`${category} =`);
    }
    // The specific gap the issue measured: nothing told the model where a
    // requirements-coverage gap belongs, so it always picked `architecture`.
    expect(msg).toContain("REQUIREMENTS-COVERAGE GAP");
  });

  it.each(prompts)("the %s prompt no longer asks for one paragraph per finding", (_name, msg) => {
    expect(msg).not.toContain('"body": "<one paragraph>"');
    expect(msg).toContain("markdown");
  });

  it.each(prompts)("the %s prompt renders the category enum from shared", (_name, msg) => {
    expect(msg).toContain(FINDING_CATEGORIES.join("|"));
  });

  // #1222 — the enum was rendered only as a bare pipe-delimited value inside
  // the JSON shape, which reads as EXAMPLES: two live agents answered `info`
  // and `migration`. The prompt now says the set is closed, spells the members
  // out again in that same sentence, and says what happens if it is ignored.
  //
  // The expected list is DERIVED from `FINDING_CATEGORIES`, so adding a
  // category breaks this test unless the prompt follows — there is no literal
  // count or member list on either side that could quietly go stale.
  it.each(prompts)("the %s prompt states the category set is CLOSED", (_name, msg) => {
    expect(msg).toContain(`The ONLY permitted categories are: ${FINDING_CATEGORIES.join("|")}.`);
    expect(msg).toContain("rewritten to `other` server-side");
  });

  it.each(prompts)("the %s prompt states the closed set for BOTH enums", (_name, msg) => {
    // The category sentence mirrors the one `derivation` has carried since
    // #1234; asserting both together is what stops one being dropped in a
    // rewrite while the other survives.
    expect(msg).toContain("Never emit any other derivation value");
    expect(msg).toContain("ONLY permitted categories");
  });
});

describe("structured-output finding schema (#1234)", () => {
  const findingSchema = (format: typeof AGENT_OUTPUT_RESPONSE_FORMAT) =>
    (
      format.json_schema.schema as {
        properties: { findings: { items: Record<string, never> } };
      }
    ).properties.findings.items as unknown as {
      required: string[];
      properties: Record<string, { enum?: unknown[]; minimum?: number; maximum?: number }>;
    };

  it.each([
    ["agent", AGENT_OUTPUT_RESPONSE_FORMAT],
    ["document agent", DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT],
  ])("the %s schema constrains confidence to 0-1", (_name, format) => {
    const schema = findingSchema(format);
    // OpenAI strict mode requires every property to be listed in `required`;
    // optionality is expressed as the nullable type.
    expect(schema.required).toContain("confidence");
    expect(schema.properties.confidence.minimum).toBe(0);
    expect(schema.properties.confidence.maximum).toBe(1);
  });

  it.each([
    ["agent", AGENT_OUTPUT_RESPONSE_FORMAT],
    ["document agent", DOCUMENT_AGENT_OUTPUT_RESPONSE_FORMAT],
  ])("the %s schema makes `extracted` undecodable", (_name, format) => {
    const schema = findingSchema(format);
    expect(schema.required).toContain("derivation");
    expect(schema.properties.derivation.enum).toEqual(["inferred", "ambiguous", null]);
  });
});
