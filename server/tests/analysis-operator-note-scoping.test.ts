/**
 * Issue #1237 — the operator's `extraInstructions` are broadcast to EVERY
 * agent's prompt. An agent with no way to satisfy them spent its
 * highest-confidence finding slot saying so.
 *
 * Measured on run `cmsgkafu00002rkwhefvr393s` (project OrderBatch): the operator
 * asked for named Java classes, methods and MyBatis mapper XML. `[database]`
 * answered "No OrderBatch source code or MyBatis mapper XML retrieved" at
 * confidence 0.95 — one of only 2 findings it produced — and `[document]`
 * answered "Missing OrderBatch codebase and SALESDB schema artifacts" at
 * confidence 1.0, its single highest-confidence item, so it sorted to the top
 * of the report. Both were correct about their own context and useless to the
 * user, whose code a sibling specialist had analysed in the same run.
 *
 * WHY THESE TESTS ASSERT LITERAL STRINGS. A stub provider accepts anything, so
 * a test that asserts "no meta-complaint appears in the output" passes with the
 * fix reverted — the stub never had one either way. The only falsifiable thing
 * is the PROMPT TEXT actually handed to the provider, so that is what is
 * asserted. And the expectations are LITERALS rather than re-derived from
 * `prompts.ts`: #1222 shipped an assertion that interpolated the same
 * expression on both sides and therefore held for every possible value of it.
 * If a literal below drifts from the source, that is the test doing its job.
 */
import { describe, expect, it } from "vitest";
import {
  buildAgenticCodePrompt,
  buildDocumentExtractionPrompt,
  buildRequirementGroundedPrompt,
  buildSpecialistPrompt,
} from "../src/lib/analysis/prompts.js";

/** The operator note from the measured run, in the shape that triggered it. */
const OPERATOR_NOTE =
  "Name the specific Java classes, methods and MyBatis mapper XML statements that must change.";

/** Verbatim fragments of the #1237 rules. Deliberately not imported. */
const SCOPE_HEADLINE = "OPERATOR NOTES ARE ADDRESSED TO THE WHOLE ANALYSIS, NOT TO YOU ALONE.";
const SCOPE_NOT_A_FINDING =
  "A part of the note you cannot act on is not a gap, not a risk, and not a finding.";
const SUPPRESSION =
  "So NEVER emit a finding whose subject is the absence of that material, your inability to name artifacts you were never given, or what this run did or did not retrieve for you.";
const NOTES_REDIRECT =
  "Put it in `notes` instead — one short sentence — and emit no finding for it.";
const CARVE_OUT =
  "This does not narrow what you DO report: a requirement the project fails to meet, and material inside your own focus area that you expected and did not get, are both still findings on whatever evidence you have.";

const specialist = (agentKey: "database" | "web" | "code" | "document", overrides = {}) =>
  buildSpecialistPrompt({
    agentKey,
    projectName: "OrderBatch",
    projectDescription: "batch invoicing",
    retrievedContext: "[1] documentId=d1 chunk=0 file=UC101.pdf\nUC101 business requirements",
    extraInstructions: OPERATOR_NOTE,
    ...overrides,
  });

describe("#1237 operator-note scoping — agents that lack the context", () => {
  // The two agents that emitted the measured meta-complaints, plus `web`,
  // which shares their document-only context.
  it.each([
    ["database", "It never routes you source code or the code graph"],
    ["web", "It never routes you source code, the code graph, or a database schema"],
    ["document", "It never routes you source code, the code graph, or a database schema"],
  ] as const)("tells the %s agent what it is never routed", (agentKey, lacksClause) => {
    const { systemMessage } = specialist(agentKey);
    expect(systemMessage).toContain("YOUR CONTEXT: this pipeline routes you ");
    expect(systemMessage).toContain(lacksClause);
  });

  it.each(["database", "web", "document"] as const)(
    "forbids the %s agent from making its own missing context a finding, and names the notes channel",
    (agentKey) => {
      const { systemMessage } = specialist(agentKey);
      expect(systemMessage).toContain(SUPPRESSION);
      expect(systemMessage).toContain(NOTES_REDIRECT);
    },
  );

  it.each(["database", "web", "document", "code"] as const)(
    "tells the %s agent the operator note is addressed to the whole analysis",
    (agentKey) => {
      const { systemMessage } = specialist(agentKey);
      expect(systemMessage).toContain(SCOPE_HEADLINE);
      expect(systemMessage).toContain(SCOPE_NOT_A_FINDING);
    },
  );

  it("reaches the document agent through buildDocumentExtractionPrompt directly, not only via the specialist delegation", () => {
    const { systemMessage } = buildDocumentExtractionPrompt({
      projectName: "OrderBatch",
      projectDescription: "batch invoicing",
      retrievedContext: "[1] documentId=d1 chunk=0 file=UC101.pdf\nUC101",
      extraInstructions: OPERATOR_NOTE,
    });
    expect(systemMessage).toContain(SUPPRESSION);
    expect(systemMessage).toContain(SCOPE_HEADLINE);
    // #750's requirement-extraction contract must survive the renumbering.
    expect(systemMessage).toContain("entry in `requirements`, citing its source document");
    expect(systemMessage).toContain("7. Output JSON only");
  });
});

describe("#1237 a genuine missing-context case still surfaces", () => {
  it.each(["database", "web", "document", "code"] as const)(
    "keeps the %s agent's carve-out for the project's own gaps and for its own focus area",
    (agentKey) => {
      const { systemMessage } = specialist(agentKey);
      expect(systemMessage).toContain(CARVE_OUT);
    },
  );

  it.each(["database", "web", "document"] as const)(
    "leaves the %s agent's pre-existing insufficient-context finding rule (rule 2) intact",
    (agentKey) => {
      const { systemMessage } = specialist(agentKey);
      expect(systemMessage).toContain(
        "If the context is insufficient, return findings with severity=info and an explanatory note.",
      );
    },
  );

  it("never gives the code agent a suppression clause — its remit IS the source code", () => {
    const { systemMessage } = specialist("code");
    expect(systemMessage).toContain(
      "YOUR CONTEXT: this pipeline routes you the project's source code",
    );
    expect(systemMessage).not.toContain("It never routes you");
    expect(systemMessage).not.toContain(SUPPRESSION);
  });

  it("does not broadcast the suppression clause into the agentic code prompt, whose could-not-verify contract mandates exactly such a finding (#773)", () => {
    const { systemMessage } = buildAgenticCodePrompt({
      projectName: "OrderBatch",
      projectDescription: "batch invoicing",
      requirements: [{ id: "REQ-001", text: "settle in batch" }],
    });
    expect(systemMessage).not.toContain(SUPPRESSION);
    expect(systemMessage).not.toContain("It never routes you");
    // The #773 contract the suppression clause would have contradicted.
    expect(systemMessage).toContain("ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE");
  });

  it("does not broadcast the suppression clause into the requirement-grounded code prompt, whose rule 4 mandates a no-evidence finding", () => {
    const { systemMessage } = buildRequirementGroundedPrompt({
      projectName: "OrderBatch",
      projectDescription: "batch invoicing",
      requirements: [{ id: "REQ-001", text: "settle in batch", evidence: "" }],
      extraInstructions: OPERATOR_NOTE,
    });
    expect(systemMessage).not.toContain(SUPPRESSION);
    expect(systemMessage).toContain(
      "If a requirement has NO evidence or you cannot ground a claim, emit a finding with severity=info",
    );
  });
});

describe("#1237 prompt-prefix stability and the trust boundary", () => {
  // #385/#652 depend on a byte-stable lead for prompt caching, and #1225
  // measured that perturbing it costs a cache invalidation per turn. The rules
  // are static per agent key, so two runs of the same agent over different
  // retrieval and different operator notes must produce the SAME lead.
  it.each(["database", "web", "document", "code"] as const)(
    "keeps the %s agent's system lead byte-identical across differing retrieval and operator notes",
    (agentKey) => {
      const a = specialist(agentKey, {
        retrievedContext: "[1] documentId=d1 chunk=0 file=a.pdf\nfirst run",
        extraInstructions: OPERATOR_NOTE,
      });
      const b = specialist(agentKey, {
        retrievedContext: "[1] documentId=d9 chunk=7 file=z.pdf\ncompletely different corpus",
        extraInstructions: "Something else entirely: audit retention windows.",
      });
      const c = specialist(agentKey, { extraInstructions: undefined });
      expect(b.systemMessage).toBe(a.systemMessage);
      expect(c.systemMessage).toBe(a.systemMessage);
    },
  );

  it.each(["database", "web", "document", "code"] as const)(
    "keeps the %s agent's rules OUT of the user message, where the fences mark everything untrusted",
    (agentKey) => {
      const { userMessage } = specialist(agentKey);
      // Rule 1 tells the model everything inside the data boundaries is data,
      // never instructions. A trusted instruction placed there would be read as
      // untrusted — and the user message is the only place user-controlled text
      // is interpolated, so it is also where an injection could forge one.
      expect(userMessage).not.toContain(SCOPE_HEADLINE);
      expect(userMessage).not.toContain("YOUR CONTEXT: this pipeline routes you ");
      expect(userMessage).not.toContain(SUPPRESSION);
      // The operator note itself still reaches the model, fenced, as before.
      expect(userMessage).toContain("BEGIN OPERATOR NOTES");
      expect(userMessage).toContain(OPERATOR_NOTE);
    },
  );

  it("still omits the OPERATOR NOTES boundary when the operator supplied none (#905 parity)", () => {
    const { userMessage } = specialist("database", { extraInstructions: undefined });
    expect(userMessage).not.toContain("OPERATOR NOTES");
  });

  it("keeps Sally's AFFECTED SCHEMA rules present after the #1237 renumbering (#824)", () => {
    const { systemMessage } = specialist("database", { affectedSchema: "table: SALES_DB" });
    expect(systemMessage).toContain("7. DETERMINISTIC AFFECTED SCHEMA:");
    expect(systemMessage).toContain("8. For every object in the AFFECTED SCHEMA section");
    // And they are absent when there is no block, as before.
    const { systemMessage: noSchema } = specialist("database");
    expect(noSchema).not.toContain("DETERMINISTIC AFFECTED SCHEMA:");
  });
});
