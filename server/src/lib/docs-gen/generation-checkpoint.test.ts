import { describe, expect, it } from "vitest";
import {
  errorClassOf,
  generationFailureWarning,
  partialDocumentMarkdown,
  UnpublishableGenerationError,
} from "./generation-checkpoint.js";
import {
  GENERATION_FAILED_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
  GENERATION_PROVIDER_SLOW_MESSAGE,
} from "./generation-failure-message.js";
import { hashSectionInputs, recordSectionSynthesis } from "./section-reuse.js";

const SECRET = 'openai returned 500 {"prompt":"customer data"} at /srv/metis/x.ts:9';

describe("#782 — errorClassOf", () => {
  it("names the class, never the message", () => {
    expect(errorClassOf(new TypeError(SECRET))).toBe("TypeError");
    class ZodError extends Error {
      override name = "ZodError";
    }
    expect(errorClassOf(new ZodError(SECRET))).toBe("ZodError");
  });

  it("does not echo a name that is not an identifier, or a non-Error", () => {
    const err = new Error("x");
    err.name = SECRET;
    expect(errorClassOf(err)).toBe("Error");
    expect(errorClassOf(SECRET)).toBe("non-Error value");
    expect(errorClassOf(undefined)).toBe("non-Error value");
  });
});

describe("#782 — generationFailureWarning", () => {
  it("names the section, stage and error class, and the fixed-vocabulary reason", () => {
    const w = generationFailureWarning({
      stage: "sections",
      section: "Integrations & Glossary",
      err: new RangeError(SECRET),
    });
    expect(w).toMatchObject({
      kind: "section-failed",
      section: "Integrations & Glossary",
      severity: "error",
      detailSafe: true,
      stage: "sections",
      errorClass: "RangeError",
    });
    expect(w.message).toBe(
      `Section "Integrations & Glossary" could not be generated: generation stopped while writing sections (phase 2), in this section (RangeError). ${GENERATION_FAILED_MESSAGE}`,
    );
    expect(JSON.stringify(w)).not.toContain("customer data");
  });

  it("is a document-level cause outside the section stage", () => {
    for (const [stage, text] of [
      ["setup", "while preparing the generation"],
      ["facts", "while extracting facts from the source (phase 1)"],
      ["assembly", "after the sections were written, while assembling the document"],
      ["commit", "while saving the document"],
    ] as const) {
      const w = generationFailureWarning({ stage, section: "Rules", err: new Error("x") });
      expect(w.section).toBe("Rules");
      expect(w.message).toContain(`generation stopped ${text} (Error).`);
      expect(w.message).not.toContain("in this section");
    }
    expect(generationFailureWarning({ stage: "commit", section: "  ", err: 1 }).section).toBe(
      "Document",
    );
  });

  it("keeps the provider-specific reason", () => {
    const err = Object.assign(new Error("402 Insufficient Balance"), { status: 402 });
    const w = generationFailureWarning({ stage: "facts", err });
    expect(w.message).toContain(GENERATION_PROVIDER_BALANCE_MESSAGE);
  });

  it("drops a reason that would be cut mid-sentence, keeping the stage", () => {
    const err = Object.assign(new Error("headers"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    const w = generationFailureWarning({ stage: "sections", section: "Rules", err });
    expect(GENERATION_PROVIDER_SLOW_MESSAGE.length).toBeGreaterThan(200);
    expect(w.message).toBe(
      'Section "Rules" could not be generated: generation stopped while writing sections (phase 2), in this section (Error).',
    );
  });

  it("explains an unpublishable run in its own words", () => {
    const changed = generationFailureWarning({
      stage: "commit",
      err: new UnpublishableGenerationError("inputs-changed", SECRET),
    });
    expect(changed.errorClass).toBe("UnpublishableGenerationError");
    expect(changed.message).toContain("sources changed while this document was being generated");
    expect(changed.message).not.toContain("customer data");
    expect(
      generationFailureWarning({
        stage: "commit",
        err: new UnpublishableGenerationError("superseded", "x"),
      }).message,
    ).toContain("deleted or replaced");
    expect(
      generationFailureWarning({
        stage: "setup",
        err: new UnpublishableGenerationError("aborted", "x"),
      }).message,
    ).toContain("cancelled");
  });
});

describe("#782 — partialDocumentMarkdown", () => {
  const rec = (id: string, index: number) =>
    recordSectionSynthesis(
      id,
      hashSectionInputs({
        facts: id,
        formulas: "",
        flow: "",
        grounding: "",
        context: "",
        config: "",
        prompts: "",
      }),
      {
        markdown: `## ${id}\n\nBody ${id}.\n`,
        warnings: [],
        score: null,
        metadata: {
          sectionLabel: id,
          sectionIndex: index,
          providerKind: "anthropic",
          model: "m",
          factsSourceIds: [],
          groundingSourceIds: [],
        },
        evidence: [],
      },
    );

  it("orders the finished sections and says the document is incomplete", () => {
    const md = partialDocumentMarkdown("BRD", [rec("Rules", 2), rec("Overview", 0)]);
    expect(md.startsWith("# BRD\n\n> **Incomplete document.**")).toBe(true);
    expect(md).toContain("2 finished sections are shown below");
    expect(md.indexOf("## Overview")).toBeLessThan(md.indexOf("## Rules"));
  });

  it("uses the singular for one section", () => {
    expect(partialDocumentMarkdown("BRD", [rec("Overview", 0)])).toContain(
      "1 finished section is shown below",
    );
  });
});
