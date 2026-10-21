import { describe, expect, it } from "vitest";
import { AIProviderError } from "../ai/errors.js";
import {
  errorClassOf,
  generationFailureWarning,
  hasCutOffSections,
  hasFailedSections,
  hasSectionsToRedraft,
  isSectionRedraftReset,
  markDroppedAttempts,
  partialDocumentMarkdown,
  sectionFailureWarning,
  UnpublishableGenerationError,
} from "./generation-checkpoint.js";
import {
  GENERATION_FAILED_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
  GENERATION_PROVIDER_DROPPED_MESSAGE,
  GENERATION_PROVIDER_SLOW_MESSAGE,
  isBodyTimeout,
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

  describe("#996 — citations in the kept sections", () => {
    const repoId = `repo:${encodeURIComponent(JSON.stringify(["r", "g", "internal/storage"]))}`;
    const storage = `facts:${repoId}:0`;
    const cited = (id: string, index: number, markdown: string, evidence: string[]) =>
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
          markdown,
          warnings: [],
          score: null,
          metadata: {
            sectionLabel: id,
            sectionIndex: index,
            providerKind: "anthropic",
            model: "m",
            factsSourceIds: [],
            groundingSourceIds: evidence,
          },
          evidence: evidence.map((sourceId) => ({
            sourceId,
            kind: sourceId.startsWith("rag:") ? ("rag" as const) : ("facts" as const),
            label: sourceId.startsWith("rag:") ? "README.md" : "storage",
            evidenceClass: "repository-source" as const,
            contentHash: "h",
          })),
        },
      );

    it("renders each admitted source id as a document-wide footnote", () => {
      const md = partialDocumentMarkdown("Architecture", [
        cited("Overview", 0, `## Overview\n\nFeeds are stored per user ([${storage}]).\n`, [
          storage,
        ]),
        cited(
          "Components",
          1,
          `## Components\n\nStorage again [${storage}] and docs [rag:doc1:c2].\n`,
          [storage, "rag:doc1:c2"],
        ),
      ]);
      expect(md).toContain("Feeds are stored per user[^src-1].");
      expect(md).toContain("Storage again[^src-1] and docs[^src-2].");
      expect(md).toContain("[^src-1]: `internal/storage` (module facts)");
      expect(md).toContain("[^src-2]: `README.md` (retrieved excerpt)");
      expect(md).not.toMatch(/\[(?:facts|rag|web):/);
      expect(md).not.toContain("%5B");
      expect(md).not.toContain("(,");
    });

    it("drops an id no kept section admitted, as the finished document does", () => {
      const md = partialDocumentMarkdown("Architecture", [
        cited("Overview", 0, "## Overview\n\nInvented [facts:nowhere:3].\n", []),
      ]);
      expect(md).toContain("Invented.");
      expect(md).not.toContain("facts:");
      expect(md).not.toContain("[^src-");
    });
  });
});

describe("#942 — sectionFailureWarning", () => {
  it("names the error class of an unrecognised failure, never its text", () => {
    const w = sectionFailureWarning("Overview", new SyntaxError(SECRET));
    expect(w).toMatchObject({ kind: "section-failed", section: "Overview", detailSafe: true });
    expect(w.message).toContain("(SyntaxError)");
    expect(w.message).not.toContain("customer data");
    expect(w.message).not.toContain(GENERATION_FAILED_MESSAGE);
  });

  it("keeps a recognised failure's fixed message as it is", () => {
    const w = sectionFailureWarning("Overview", new Error("402 Insufficient Balance"));
    expect(w.message).toContain(GENERATION_PROVIDER_BALANCE_MESSAGE);
    expect(w.message).not.toContain("(Error)");
  });
});

describe("#1209 — sectionFailureWarning for a connection that dropped", () => {
  /** The Anthropic adapter's wrapped drop: the transport classifier does not recognise it. */
  const anthropicDrop = () =>
    new AIProviderError("anthropic stream failed (TypeError): terminated", 502, {
      provider: "anthropic",
      operation: "stream",
      errorName: "TypeError",
    });

  it("says the provider's connection dropped, with the attempts the draft made", () => {
    const err = markDroppedAttempts(anthropicDrop(), { attempts: 3, retriesStopped: false });
    expect(sectionFailureWarning("Overview", err).message).toBe(
      'Section "Overview" could not be generated: the AI provider\'s connection dropped while it was writing this section (3 attempts). Regenerate the document to try this section again; the finished sections are reused.',
    );
  });

  it("says when METIS had stopped retrying, in the singular", () => {
    const err = markDroppedAttempts(anthropicDrop(), { attempts: 1, retriesStopped: true });
    expect(sectionFailureWarning("Overview", err).message).toContain(
      "(1 attempt; METIS stopped retrying after the connection dropped on earlier sections too)",
    );
  });

  it("falls back to the grounding classifier when the transport classifier does not recognise the drop", () => {
    const w = sectionFailureWarning("Overview", anthropicDrop());
    expect(w.message).toContain(
      "the AI provider's connection dropped while it was writing this section. Regenerate",
    );
    expect(w.message).not.toContain("unrecognised error");
  });

  it("PR #1274 review — an unreachable host wrapped by the Anthropic adapter is not called a dropped reply", () => {
    const err = new AIProviderError(
      "anthropic stream failed (APIConnectionError): Connection error.",
      502,
      {
        provider: "anthropic",
        operation: "stream",
        errorName: "APIConnectionError",
      },
    );
    const w = sectionFailureWarning("Overview", err);
    expect(w.message).not.toContain("dropped");
    expect(w.message).toContain("unrecognised error (AIProviderError)");
  });

  it("leaves a drop the transport classifier recognises with its own message when no count is known", () => {
    const w = sectionFailureWarning("Overview", new TypeError("terminated"));
    expect(w.message).toContain(GENERATION_PROVIDER_DROPPED_MESSAGE);
  });
});

describe("#1209 — isBodyTimeout", () => {
  it("reads undici's body timeout under `terminated`, by code or by name", () => {
    const byCode = new TypeError("terminated", {
      cause: Object.assign(new Error("Body Timeout Error"), { code: "UND_ERR_BODY_TIMEOUT" }),
    });
    const byName = new TypeError("terminated", {
      cause: Object.assign(new Error("Body Timeout Error"), { name: "BodyTimeoutError" }),
    });
    expect(isBodyTimeout(byCode)).toBe(true);
    expect(isBodyTimeout(byName)).toBe(true);
  });

  it("is false for a real drop", () => {
    const reset = new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    expect(isBodyTimeout(reset)).toBe(false);
    expect(isBodyTimeout(new TypeError("terminated"))).toBe(false);
    expect(isBodyTimeout("terminated")).toBe(false);
  });
});

describe("#1132 — hasCutOffSections / hasSectionsToRedraft", () => {
  it("a cut-off section makes a published document regeneratable, like a failed one", () => {
    const cut = [{ kind: "section-truncated", section: "Components" }];
    expect(hasCutOffSections(cut)).toBe(true);
    expect(hasSectionsToRedraft(cut)).toBe(true);
    expect(hasSectionsToRedraft([{ kind: "section-failed", section: "A" }])).toBe(true);
    expect(hasCutOffSections([{ kind: "section-failed", section: "A" }])).toBe(false);
    expect(hasSectionsToRedraft([{ kind: "section-ungrounded", section: "A" }])).toBe(false);
    expect(hasSectionsToRedraft([null, "x"])).toBe(false);
    expect(hasSectionsToRedraft(null)).toBe(false);
  });
});

describe("#1132 — isSectionRedraftReset", () => {
  it("is a published degraded doc's redraft reset, never a failed or cancelled run's row", () => {
    const cut = { kind: "section-truncated", section: "Components" };
    expect(isSectionRedraftReset([cut])).toBe(true);
    expect(isSectionRedraftReset([{ kind: "section-failed", section: "A" }])).toBe(true);
    // A failed or cancelled run carries its stop cause (a `stage`) beside it.
    expect(isSectionRedraftReset([cut, { kind: "section-failed", stage: "sections" }])).toBe(false);
    expect(isSectionRedraftReset([{ kind: "section-ungrounded", section: "A" }])).toBe(false);
    expect(isSectionRedraftReset(null)).toBe(false);
  });
});

describe("#942 — hasFailedSections", () => {
  it("is true only for a section-failed warning that is not a stop cause", () => {
    expect(hasFailedSections([{ kind: "section-failed", section: "A" }])).toBe(true);
    expect(hasFailedSections([{ kind: "section-failed", section: "D", stage: "commit" }])).toBe(
      false,
    );
    expect(hasFailedSections([{ kind: "section-ungrounded", section: "A" }])).toBe(false);
    expect(hasFailedSections([null, "x"])).toBe(false);
    expect(hasFailedSections(null)).toBe(false);
    expect(hasFailedSections("[]")).toBe(false);
  });
});
