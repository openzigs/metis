import { describe, it, expect, afterEach } from "vitest";
import {
  sectionFailedWarning,
  sectionUngroundedWarning,
  sectionUnfaithfulWarning,
  sectionPartlyGroundedWarning,
  sectionUnderReconstructedWarning,
  deriveDocStatus,
  serializeWarnings,
  summarizeWarnings,
  faithfulnessThreshold,
  resolveSectionFaithfulnessThreshold,
  noModulesWarning,
  sourceUnavailableWarning,
  factsTruncatedWarning,
  phase1FactsTruncatedWarning,
  sectionTruncatedWarning,
  sectionMissingWarning,
  batchTruncatedWarning,
  batchFailedWarning,
  batchUnverifiedWarning,
  groundingSkippedWarning,
  groundingSampledWarning,
  markWarningSampled,
  DEFAULT_FAITHFULNESS_THRESHOLD,
  NARRATIVE_FAITHFULNESS_THRESHOLD,
  RECONSTRUCTION_FAITHFULNESS_THRESHOLD,
  type DocWarning,
  type DocWarningTier,
} from "./degraded-warnings.js";

describe("sectionFailedWarning", () => {
  it("produces an error-severity warning with the detail", () => {
    const w = sectionFailedWarning("Business Rules", "gateway 504");
    expect(w.kind).toBe("section-failed");
    expect(w.severity).toBe("error");
    expect(w.section).toBe("Business Rules");
    expect(w.message).toContain("Business Rules");
    expect(w.message).toContain("gateway 504");
  });

  it("truncates very long details", () => {
    const w = sectionFailedWarning("X", "y".repeat(1000));
    expect(w.message.length).toBeLessThan(400);
  });
});

describe("sectionUngroundedWarning", () => {
  it("reports ungrounded vs total claim counts at warning severity", () => {
    const w = sectionUngroundedWarning("Workflows", 3, 10);
    expect(w.kind).toBe("section-ungrounded");
    expect(w.severity).toBe("warning");
    expect(w.message).toContain("3 of 10");
    // Calibrated framing: "not auto-verified / review", never "unreliable".
    expect(w.message).toContain("could not be automatically verified");
    expect(w.message).not.toContain("unreliable");
  });
});

describe("faithfulnessThreshold (#273)", () => {
  const orig = process.env.DOCS_FAITHFULNESS_THRESHOLD;
  afterEach(() => {
    if (orig === undefined) delete process.env.DOCS_FAITHFULNESS_THRESHOLD;
    else process.env.DOCS_FAITHFULNESS_THRESHOLD = orig;
  });

  it("defaults to the named constant (~0.8) when env is unset", () => {
    delete process.env.DOCS_FAITHFULNESS_THRESHOLD;
    expect(faithfulnessThreshold()).toBe(DEFAULT_FAITHFULNESS_THRESHOLD);
    expect(DEFAULT_FAITHFULNESS_THRESHOLD).toBeCloseTo(0.8, 5);
  });

  it("honours a valid DOCS_FAITHFULNESS_THRESHOLD override in [0,1]", () => {
    process.env.DOCS_FAITHFULNESS_THRESHOLD = "0.6";
    expect(faithfulnessThreshold()).toBe(0.6);
  });

  it("ignores an out-of-range or non-numeric override and falls back to default", () => {
    process.env.DOCS_FAITHFULNESS_THRESHOLD = "2";
    expect(faithfulnessThreshold()).toBe(DEFAULT_FAITHFULNESS_THRESHOLD);
    process.env.DOCS_FAITHFULNESS_THRESHOLD = "abc";
    expect(faithfulnessThreshold()).toBe(DEFAULT_FAITHFULNESS_THRESHOLD);
  });
});

describe("sectionUnfaithfulWarning (#273)", () => {
  it("carries the numeric ratio and threshold for persistence + UI", () => {
    const w = sectionUnfaithfulWarning("Overview & Domain", {
      supportedClaims: 3,
      totalClaims: 10,
      faithfulness: 0.3,
      threshold: 0.8,
    });
    expect(w.kind).toBe("section-ungrounded");
    expect(w.severity).toBe("warning");
    expect(w.ratio).toBeCloseTo(0.3, 5);
    expect(w.threshold).toBeCloseTo(0.8, 5);
    expect(w.message).toContain("Overview & Domain");
    expect(w.message).toContain("30%");
    expect(w.message).toContain("80%");
    // Calibrated literal-tier framing: "not auto-verified / review", not "unreliable".
    expect(w.message.toLowerCase()).toContain("review");
    expect(w.message).not.toContain("may be unreliable");
  });

  it("round-trips the numeric ratio through serializeWarnings", () => {
    const w = sectionUnfaithfulWarning("S", {
      supportedClaims: 1,
      totalClaims: 4,
      faithfulness: 0.25,
      threshold: 0.8,
    });
    const json = serializeWarnings([w]);
    const parsed = JSON.parse(json!) as DocWarning[];
    expect(parsed[0].ratio).toBeCloseTo(0.25, 5);
    expect(parsed[0].threshold).toBeCloseTo(0.8, 5);
  });
});

describe("resolveSectionFaithfulnessThreshold (#283)", () => {
  const orig = process.env.DOCS_FAITHFULNESS_THRESHOLD;
  afterEach(() => {
    if (orig === undefined) delete process.env.DOCS_FAITHFULNESS_THRESHOLD;
    else process.env.DOCS_FAITHFULNESS_THRESHOLD = orig;
  });

  it("uses the global faithfulness threshold for code-derived sections (no override)", () => {
    delete process.env.DOCS_FAITHFULNESS_THRESHOLD;
    expect(resolveSectionFaithfulnessThreshold(undefined)).toBe(DEFAULT_FAITHFULNESS_THRESHOLD);
  });

  it("applies a per-section override for inherently-abstractive narrative sections", () => {
    delete process.env.DOCS_FAITHFULNESS_THRESHOLD;
    expect(resolveSectionFaithfulnessThreshold(NARRATIVE_FAITHFULNESS_THRESHOLD)).toBe(
      NARRATIVE_FAITHFULNESS_THRESHOLD,
    );
    expect(NARRATIVE_FAITHFULNESS_THRESHOLD).toBeLessThan(DEFAULT_FAITHFULNESS_THRESHOLD);
  });

  it("ignores an out-of-range override and falls back to the global default", () => {
    delete process.env.DOCS_FAITHFULNESS_THRESHOLD;
    expect(resolveSectionFaithfulnessThreshold(2)).toBe(DEFAULT_FAITHFULNESS_THRESHOLD);
    expect(resolveSectionFaithfulnessThreshold(-1)).toBe(DEFAULT_FAITHFULNESS_THRESHOLD);
    expect(resolveSectionFaithfulnessThreshold(Number.NaN)).toBe(DEFAULT_FAITHFULNESS_THRESHOLD);
  });

  it("the global override still flows through when no per-section value is set", () => {
    process.env.DOCS_FAITHFULNESS_THRESHOLD = "0.65";
    expect(resolveSectionFaithfulnessThreshold(undefined)).toBe(0.65);
    // A per-section override still wins over the env global.
    expect(resolveSectionFaithfulnessThreshold(0.4)).toBe(0.4);
  });

  it("resolves the reconstruction threshold as a valid per-section override", () => {
    delete process.env.DOCS_FAITHFULNESS_THRESHOLD;
    expect(resolveSectionFaithfulnessThreshold(RECONSTRUCTION_FAITHFULNESS_THRESHOLD)).toBe(
      RECONSTRUCTION_FAITHFULNESS_THRESHOLD,
    );
  });

  it("lets the env override win even for reconstruction sections that set a threshold", () => {
    // The resolve logic is uniform: an out-of-range value falls back to the env
    // global, but a valid per-section value (including reconstruction's) is kept.
    // Operators tune the global; sections that opt into a moderate bar still pass
    // an in-range override which wins by design — documenting the env precedence
    // contract for the moderate tier.
    process.env.DOCS_FAITHFULNESS_THRESHOLD = "0.9";
    // A valid per-section reconstruction override is honoured over the env.
    expect(resolveSectionFaithfulnessThreshold(RECONSTRUCTION_FAITHFULNESS_THRESHOLD)).toBe(
      RECONSTRUCTION_FAITHFULNESS_THRESHOLD,
    );
    // An out-of-range section value falls back to the env global (0.9), not 0.6.
    expect(resolveSectionFaithfulnessThreshold(5)).toBe(0.9);
  });
});

describe("RECONSTRUCTION_FAITHFULNESS_THRESHOLD", () => {
  it("sits strictly between the narrative floor and the strict default", () => {
    expect(RECONSTRUCTION_FAITHFULNESS_THRESHOLD).toBeGreaterThan(NARRATIVE_FAITHFULNESS_THRESHOLD);
    expect(RECONSTRUCTION_FAITHFULNESS_THRESHOLD).toBeLessThan(DEFAULT_FAITHFULNESS_THRESHOLD);
    expect(RECONSTRUCTION_FAITHFULNESS_THRESHOLD).toBeCloseTo(0.6, 5);
  });
});

describe("sectionUnderReconstructedWarning", () => {
  it("frames the gap as inferred reconstruction to verify, NOT fabrication or domain knowledge", () => {
    const w = sectionUnderReconstructedWarning("Key Workflows", {
      supportedClaims: 2,
      totalClaims: 7,
      faithfulness: 2 / 7,
      threshold: 0.6,
    });
    expect(w.kind).toBe("section-ungrounded");
    expect(w.severity).toBe("warning");
    expect(w.section).toBe("Key Workflows");
    expect(w.message).toContain("Key Workflows");
    expect(w.message).toContain("inferred");
    expect(w.message).toContain("verify");
    expect(w.message).toContain("reconstruct");
    expect(w.message).toContain("29%"); // round(2/7 * 100)
    expect(w.message).toContain("60%"); // threshold
    // It must NOT use the alarming literal-section copy nor the domain-narrative copy.
    expect(w.message).not.toContain("may be unreliable");
    expect(w.message).not.toContain("domain/business context from general knowledge");
    expect(w.ratio).toBeCloseTo(2 / 7, 5);
    expect(w.threshold).toBeCloseTo(0.6, 5);
    // Unlike the narrative warning, reconstruction does NOT set domainContext.
    expect(w.domainContext).toBeUndefined();
  });

  it("contributes a degraded status and round-trips through serializeWarnings", () => {
    const w = sectionUnderReconstructedWarning("Data & Domain Model", {
      supportedClaims: 3,
      totalClaims: 12,
      faithfulness: 0.25,
      threshold: 0.6,
    });
    expect(deriveDocStatus([w])).toBe("degraded");
    const parsed = JSON.parse(serializeWarnings([w])!) as DocWarning[];
    expect(parsed[0].ratio).toBeCloseTo(0.25, 5);
    expect(parsed[0].threshold).toBeCloseTo(0.6, 5);
  });
});

describe("sectionPartlyGroundedWarning (#283)", () => {
  it("frames the gap as domain context, NOT as unreliable", () => {
    const w = sectionPartlyGroundedWarning("Overview & Domain", {
      supportedClaims: 9,
      totalClaims: 44,
      faithfulness: 9 / 44,
      threshold: 0.4,
    });
    expect(w.kind).toBe("section-ungrounded");
    expect(w.severity).toBe("warning");
    expect(w.message).toContain("Overview & Domain");
    expect(w.message).toContain("grounded in source code");
    expect(w.message).toContain("domain/business context from general knowledge");
    // The alarming framing must be gone.
    expect(w.message).not.toContain("unreliable");
    expect(w.message).not.toContain("could not be grounded");
    expect(w.message).toContain("20%"); // round(9/44 * 100)
    expect(w.ratio).toBeCloseTo(9 / 44, 5);
    expect(w.threshold).toBeCloseTo(0.4, 5);
    // #283 — UI discriminator so the banner renders calm, not alarming, copy.
    expect(w.domainContext).toBe(true);
  });

  it("still contributes a degraded status (carries a warning)", () => {
    const w = sectionPartlyGroundedWarning("Core Business Capabilities", {
      supportedClaims: 2,
      totalClaims: 10,
      faithfulness: 0.2,
      threshold: 0.4,
    });
    expect(deriveDocStatus([w])).toBe("degraded");
  });
});

describe("deriveDocStatus", () => {
  it("returns ready when there are no warnings", () => {
    expect(deriveDocStatus([])).toBe("ready");
  });

  it("returns degraded when any warning exists — never a clean ready", () => {
    expect(deriveDocStatus([sectionFailedWarning("A", "boom")])).toBe("degraded");
    expect(deriveDocStatus([sectionUngroundedWarning("B", 1, 2)])).toBe("degraded");
  });
});

describe("serializeWarnings", () => {
  it("returns null for no warnings (keeps the persisted field clean)", () => {
    expect(serializeWarnings([])).toBeNull();
  });

  it("round-trips warnings as JSON", () => {
    const warnings: DocWarning[] = [sectionFailedWarning("A", "x")];
    const json = serializeWarnings(warnings);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!)).toEqual(warnings);
  });
});

describe("tier discriminator (tier-aware banner)", () => {
  const breakdown = (faithfulness: number, threshold: number) => ({
    supportedClaims: Math.round(faithfulness * 10),
    totalClaims: 10,
    faithfulness,
    threshold,
  });

  it("tags a NARRATIVE section (Overview/Capabilities) with tier 'narrative' + domainContext", () => {
    const w = sectionPartlyGroundedWarning("Overview & Domain", breakdown(0.2, 0.4));
    expect(w.tier).toBe<DocWarningTier>("narrative");
    // The legacy boolean stays in lock-step so old UI keeps working.
    expect(w.domainContext).toBe(true);
  });

  it("tags a RECONSTRUCTION section (Workflows/Data Model) with tier 'reconstruction', no domainContext", () => {
    const w = sectionUnderReconstructedWarning("Key Workflows", breakdown(0.3, 0.6));
    expect(w.tier).toBe<DocWarningTier>("reconstruction");
    // Reconstruction is NOT domain narrative, so the legacy boolean must be unset
    // (otherwise the old UI would mis-render it as calm narrative copy).
    expect(w.domainContext).toBeUndefined();
  });

  it("tags a LITERAL code-derived section (Business Rules/Calculations/Integrations) with tier 'literal'", () => {
    const w = sectionUnfaithfulWarning("Business Rules", breakdown(0.5, 0.8));
    expect(w.tier).toBe<DocWarningTier>("literal");
    expect(w.domainContext).toBeUndefined();
  });

  it("does NOT tag a tier on section-failed, no-modules, or the legacy count-based warning", () => {
    expect(sectionFailedWarning("Calculations", "boom").tier).toBeUndefined();
    expect(noModulesWarning(7).tier).toBeUndefined();
    expect(sectionUngroundedWarning("Workflows", 2, 9).tier).toBeUndefined();
  });

  it("round-trips the tier through serializeWarnings (persisted + readable by the UI)", () => {
    const warnings: DocWarning[] = [
      sectionPartlyGroundedWarning("Overview & Domain", breakdown(0.2, 0.4)),
      sectionUnderReconstructedWarning("Data & Domain Model", breakdown(0.3, 0.6)),
      sectionUnfaithfulWarning("Integrations", breakdown(0.5, 0.8)),
    ];
    const parsed = JSON.parse(serializeWarnings(warnings)!) as DocWarning[];
    expect(parsed.map((w) => w.tier)).toEqual<DocWarningTier[]>([
      "narrative",
      "reconstruction",
      "literal",
    ]);
  });

  it("keeps each tier distinguishable from the others (no two builders share a tier)", () => {
    const tiers = new Set<DocWarningTier | undefined>([
      sectionPartlyGroundedWarning("a", breakdown(0.2, 0.4)).tier,
      sectionUnderReconstructedWarning("b", breakdown(0.3, 0.6)).tier,
      sectionUnfaithfulWarning("c", breakdown(0.5, 0.8)).tier,
    ]);
    expect(tiers.size).toBe(3);
  });
});

describe("summarizeWarnings", () => {
  it("is empty when clean", () => {
    expect(summarizeWarnings([])).toBe("");
  });

  it("summarizes failed and unverified sections with calibrated (non-alarming) framing", () => {
    const s = summarizeWarnings([
      sectionFailedWarning("A", "x"),
      sectionUngroundedWarning("B", 1, 3),
    ]);
    // Neutral "Needs review" prefix, not the alarming "Degraded output".
    expect(s).toContain("Needs review");
    expect(s).not.toContain("Degraded output");
    expect(s).toContain("1 section(s) failed");
    // Unverified ≠ wrong: framed as "not auto-verified against the source".
    expect(s).toContain("not auto-verified against the source");
  });

  it("uses the alarming 'Degraded output' prefix when source was unavailable (#330)", () => {
    const s = summarizeWarnings([sourceUnavailableWarning(2, 5)]);
    expect(s).toContain("Degraded output");
    expect(s).not.toContain("Needs review");
    expect(s).toContain("re-ingest the project");
  });

  it("keeps the alarming prefix when source-unavailable mixes with soft warnings (#330)", () => {
    const s = summarizeWarnings([
      sectionUngroundedWarning("B", 1, 3),
      sourceUnavailableWarning(1, 4),
    ]);
    // A hard source-unavailable problem dominates the framing.
    expect(s).toContain("Degraded output");
    expect(s).not.toContain("Needs review");
  });
});

describe("sourceUnavailableWarning (#330)", () => {
  it("is an error-severity, document-level, source-unavailable warning", () => {
    const w = sourceUnavailableWarning(2, 5);
    expect(w.kind).toBe("source-unavailable");
    expect(w.severity).toBe("error");
    expect(w.section).toBe("Document");
  });

  it("names the affected/total module counts and the concrete remedy", () => {
    const w = sourceUnavailableWarning(2, 5);
    expect(w.message).toContain("2 of 5");
    expect(w.message).toMatch(/0% grounded/);
    expect(w.message).toMatch(/[Rr]e-ingest/);
  });

  it("forces deriveDocStatus to 'degraded' (never a clean ready)", () => {
    expect(deriveDocStatus([sourceUnavailableWarning(1, 1)])).toBe("degraded");
  });

  it("serializes alongside other warnings", () => {
    const json = serializeWarnings([sourceUnavailableWarning(1, 3)]);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!) as DocWarning[];
    expect(parsed[0].kind).toBe("source-unavailable");
  });

  it("carries no faithfulness tier (it is not a tier-gated faithfulness warning)", () => {
    expect(sourceUnavailableWarning(1, 1).tier).toBeUndefined();
  });
});

describe("factsTruncatedWarning (#337)", () => {
  it("is a warning-severity facts-truncated warning naming the section", () => {
    const w = factsTruncatedWarning("Key Workflows", 3, 5, 48_000);
    expect(w.kind).toBe("facts-truncated");
    expect(w.severity).toBe("warning");
    expect(w.section).toBe("Key Workflows");
  });

  it("names the omitted/total module counts and the cap in the message", () => {
    const w = factsTruncatedWarning("Business Rules", 3, 5, 48_000);
    // 3 omitted of 3+5 = 8 total.
    expect(w.message).toContain("3 of 8");
    expect(w.message).toContain("48000");
    expect(w.message).toContain("DOCS_GEN_LOCAL_FACTS_CHAR_CAP");
  });

  it("tells the operator the concrete remedy (raise the cap / narrow retrieval)", () => {
    const w = factsTruncatedWarning("Data Model", 1, 4, 48_000);
    expect(w.message).toMatch(/[Rr]aise DOCS_GEN_LOCAL_FACTS_CHAR_CAP/);
    expect(w.message).toMatch(/narrow retrieval/);
  });

  it("forces deriveDocStatus to 'degraded' (an over-cap local run is observable)", () => {
    expect(deriveDocStatus([factsTruncatedWarning("X", 1, 1, 48_000)])).toBe("degraded");
  });

  it("summarizeWarnings describes the truncation with the env-var remedy", () => {
    const summary = summarizeWarnings([factsTruncatedWarning("X", 2, 3, 48_000)]);
    expect(summary).toContain("1 section(s) exceeded the facts budget");
    expect(summary).toContain("DOCS_GEN_LOCAL_FACTS_CHAR_CAP");
  });

  // PR #187 review — the banner named the LOCAL knob for every facts-truncated
  // warning, including the Bedrock/Anthropic ones #175 now raises.
  it.each([
    ["bedrock", "DOCS_GEN_BEDROCK_FACTS_CHAR_CAP"],
    ["anthropic", "DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP"],
  ] as const)("summarizeWarnings names the %s cap, never the local one", (provider, knob) => {
    const summary = summarizeWarnings([factsTruncatedWarning("X", 2, 3, 150_000, provider)]);
    expect(summary).toContain("1 section(s) exceeded the facts budget");
    expect(summary).toContain(knob);
    expect(summary).not.toContain("DOCS_GEN_LOCAL_FACTS_CHAR_CAP");
    expect(summary).not.toMatch(/local/i);
  });

  it("summarizeWarnings falls back to a generic knob name when a warning names none", () => {
    const summary = summarizeWarnings([
      { kind: "facts-truncated", section: "X", message: "omitted", severity: "warning" },
    ]);
    expect(summary).toContain("raise the provider's *_FACTS_CHAR_CAP or narrow retrieval");
  });

  it("a cloud facts-truncated warning also derives 'degraded'", () => {
    expect(deriveDocStatus([factsTruncatedWarning("X", 1, 1, 150_000, "bedrock")])).toBe(
      "degraded",
    );
  });

  it("summarizeWarnings reports Phase-1 output truncation with its own remedy", () => {
    const summary = summarizeWarnings([
      phase1FactsTruncatedWarning(["orders"]),
      factsTruncatedWarning("X", 2, 3, 150_000, "bedrock"),
    ]);
    expect(summary).toContain("1 section(s) exceeded the facts budget");
    expect(summary).toContain("fact extraction was cut off for some modules");
    expect(summary).toContain("DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS");
    expect(summary).not.toContain("DOCS_GEN_LOCAL_FACTS_CHAR_CAP");
  });

  it("serializes alongside other warnings", () => {
    const json = serializeWarnings([factsTruncatedWarning("X", 1, 3, 48_000)]);
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!) as DocWarning[];
    expect(parsed[0].kind).toBe("facts-truncated");
  });

  it("carries no faithfulness tier (it is not a tier-gated faithfulness warning)", () => {
    expect(factsTruncatedWarning("X", 1, 1, 48_000).tier).toBeUndefined();
  });
});

describe("sectionTruncatedWarning (#1226)", () => {
  it("is an error-severity section-truncated warning naming the section", () => {
    const w = sectionTruncatedWarning("Business Rules", 'provider finish reason "length"');
    expect(w.kind).toBe("section-truncated");
    expect(w.severity).toBe("error");
    expect(w.section).toBe("Business Rules");
    expect(w.message).toContain("Business Rules");
  });

  it("names the signal that fired and the concrete remedy", () => {
    const w = sectionTruncatedWarning("Key Workflows", "gateway max-tokens placeholder in output");
    expect(w.message).toContain("gateway max-tokens placeholder");
    expect(w.message).toContain("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS");
  });

  it("reports the output cap that was in force when one is known", () => {
    expect(sectionTruncatedWarning("X", "sig", 8192).message).toContain("8192 tokens");
  });

  it("still gives the remedy when the cap is unknown", () => {
    const w = sectionTruncatedWarning("X", "sig");
    expect(w.message).not.toContain("undefined");
    expect(w.message).toContain("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS");
  });

  it("forces deriveDocStatus to 'degraded' (a cut-off section is never ready)", () => {
    expect(deriveDocStatus([sectionTruncatedWarning("X", "sig", 8192)])).toBe("degraded");
  });

  it("summarizeWarnings counts it and uses the hard 'Degraded output' prefix", () => {
    const summary = summarizeWarnings([sectionTruncatedWarning("X", "sig", 8192)]);
    expect(summary).toContain("1 section(s) were cut off by the output-token cap");
    expect(summary.startsWith("Degraded output")).toBe(true);
  });

  it("round-trips through serializeWarnings", () => {
    const parsed = JSON.parse(
      serializeWarnings([sectionTruncatedWarning("X", "sig", 8192)])!,
    ) as DocWarning[];
    expect(parsed[0].kind).toBe("section-truncated");
    expect(parsed[0].severity).toBe("error");
  });
});

describe("sectionMissingWarning (#1226)", () => {
  it("is an error-severity section-missing warning naming the section and reason", () => {
    const w = sectionMissingWarning("Data & Domain Model", "no content was generated");
    expect(w.kind).toBe("section-missing");
    expect(w.severity).toBe("error");
    expect(w.section).toBe("Data & Domain Model");
    expect(w.message).toContain("Data & Domain Model");
    expect(w.message).toContain("no content was generated");
  });

  it("forces deriveDocStatus to 'degraded' (a missing section is never ready)", () => {
    expect(deriveDocStatus([sectionMissingWarning("X", "dropped during assembly")])).toBe(
      "degraded",
    );
  });

  it("summarizeWarnings counts it and uses the hard 'Degraded output' prefix", () => {
    const summary = summarizeWarnings([
      sectionMissingWarning("X", "r"),
      sectionMissingWarning("Y", "r"),
    ]);
    expect(summary).toContain("2 declared section(s) are missing");
    expect(summary.startsWith("Degraded output")).toBe(true);
  });

  it("round-trips through serializeWarnings", () => {
    const parsed = JSON.parse(
      serializeWarnings([sectionMissingWarning("X", "r")])!,
    ) as DocWarning[];
    expect(parsed[0].kind).toBe("section-missing");
  });
});

describe("#157 — batched-section warnings name the modules", () => {
  it("names a single module that alone overflows the cap, as an error that degrades the doc", () => {
    const w = batchTruncatedWarning(
      "Business Rules & Policies",
      { singleModules: ["src/billing"], allowanceSpent: [], runaway: [] },
      16_384,
    );
    expect(w.kind).toBe("section-truncated");
    expect(w.severity).toBe("error");
    expect(w.message).toContain('module "src/billing" alone writes more than one call can hold');
    expect(w.message).toContain("16384 tokens");
    expect(w.message).toContain("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS");
    expect(deriveDocStatus([w])).toBe("degraded");
  });

  it("reports the cases together, and caps the list at ten names", () => {
    const many = Array.from({ length: 13 }, (_, i) => `m${i}`);
    const w = batchTruncatedWarning(
      "Key Workflows",
      { singleModules: ["a", "b"], allowanceSpent: [many.slice(0, 7), many.slice(7)], runaway: [] },
      8_192,
    );
    expect(w.message).toContain('modules "a", "b" alone write more');
    expect(w.message).toContain('the batches covering "m0"');
    expect(w.message).toContain('"m9" and 3 more were not split again because');
    expect(w.message).not.toContain('"m10"');
  });

  // PR #169 review: "could not be split further" was said of a batch that
  // could have been split — the section's shared re-split allowance had simply
  // run out. The two reasons a multi-module batch stays whole are now distinct.
  it("says the re-split ALLOWANCE ran out, not that the batch could not be split", () => {
    const w = batchTruncatedWarning(
      "Business Rules & Policies",
      { singleModules: [], allowanceSpent: [["p0", "p1"]], runaway: [] },
      8_192,
    );
    expect(w.message).toContain(
      'the batch covering "p0", "p1" was not split again because the section\'s re-split allowance',
    );
    expect(w.message).not.toContain("could not be split");
  });

  it("names a runaway batch — cut off though estimated far below the cap — as its own case", () => {
    const w = batchTruncatedWarning(
      "Business Rules & Policies",
      { singleModules: [], allowanceSpent: [], runaway: [["tiny1", "tiny2"]] },
      8_192,
    );
    expect(w.message).toContain('the batch covering "tiny1", "tiny2" was cut off although');
    expect(w.message).toContain("repeating itself");
    expect(w.message).not.toContain("allowance");
  });

  it("names the modules a failed batch left out, with a safe detail", () => {
    const w = batchFailedWarning("Key Workflows", ["x", "y"], "the model timed out");
    expect(w.kind).toBe("section-failed");
    expect(w.detailSafe).toBe(true);
    expect(w.message).toBe(
      'Section "Key Workflows" is incomplete: the part written from "x", "y" could not be generated: the model timed out.',
    );
    expect(batchFailedWarning("S", ["x"], "Timed out.").message).toMatch(/Timed out\.$/);
    expect(batchFailedWarning("S", ["x"], "  ").message).toMatch(/could not be generated\.$/);
  });

  it("says how much of a batched section its score actually covers", () => {
    const w = batchUnverifiedWarning("Key Workflows", ["x", "y"], 3, 5);
    expect(w.kind).toBe("section-ungrounded");
    expect(w.severity).toBe("warning");
    expect(w.message).toBe(
      'Section "Key Workflows": the part written from "x", "y" could not be checked against ' +
        "the source, so the section's faithfulness score covers only 3 of its 5 parts. Review " +
        "that part against the code before relying on it.",
    );
  });
});

describe("DOCS_GEN_GROUNDING warnings", () => {
  const sample = {
    rate: 0.25,
    passagesChecked: 5,
    passagesTotal: 20,
    charsChecked: 1_000,
    charsTotal: 4_000,
  };

  it("off: a not-fact-checked warning with no score, and the doc is degraded", () => {
    const w = groundingSkippedWarning("Business Rules");
    expect(w).toMatchObject({
      kind: "grounding-skipped",
      section: "Business Rules",
      severity: "warning",
    });
    expect(w.message).toContain("NOT fact-checked");
    expect(w.message).toContain("DOCS_GEN_GROUNDING=off");
    expect(w.ratio).toBeUndefined();
    expect(deriveDocStatus([w])).toBe("degraded");
    expect(summarizeWarnings([w, groundingSkippedWarning("Overview")])).toBe(
      "Needs review — 2 section(s) were not fact-checked (DOCS_GEN_GROUNDING=off).",
    );
  });

  it("sample above the bar: labelled a spot-check estimate, carrying the sampled ratio", () => {
    const w = groundingSampledWarning(
      "Overview",
      { supportedClaims: 9, totalClaims: 10, faithfulness: 0.9, threshold: 0.4 },
      sample,
    );
    expect(w).toMatchObject({
      kind: "grounding-sampled",
      ratio: 0.9,
      threshold: 0.4,
      sampled: true,
    });
    expect(w.message).toContain("SPOT-CHECKED");
    expect(w.message).toContain("5 of its 20 passages (about 25% of its text)");
    expect(w.message).toContain("90% of those (9 of 10)");
    expect(w.message).toContain("not a full verification");
    expect(w.message).not.toContain("could not be parsed");
    expect(deriveDocStatus([w])).toBe("degraded");
    expect(summarizeWarnings([w])).toContain("1 section(s) were only spot-checked");
    const unparsed = groundingSampledWarning(
      "Overview",
      { supportedClaims: 9, totalClaims: 10, faithfulness: 0.9, threshold: 0.4, unparseable: true },
      sample,
    );
    expect(unparsed.message).toContain("could not be parsed");
  });

  it("sample below the bar: the tier warning is prefixed and flagged sampled, kind and tier kept", () => {
    const base = sectionUnfaithfulWarning("Rules", {
      supportedClaims: 5,
      totalClaims: 10,
      faithfulness: 0.5,
      threshold: 0.8,
    });
    const w = markWarningSampled(base, sample);
    expect(w.kind).toBe("section-ungrounded");
    expect(w.tier).toBe("literal");
    expect(w.ratio).toBe(0.5);
    expect(w.sampled).toBe(true);
    expect(w.message.startsWith("[Spot-check only (DOCS_GEN_GROUNDING=sample)")).toBe(true);
    expect(w.message).toContain(base.message);
    expect(base.sampled).toBeUndefined();
  });

  it("zero-length coverage renders 0% instead of NaN", () => {
    const w = groundingSampledWarning(
      "X",
      { supportedClaims: 1, totalClaims: 1, faithfulness: 1, threshold: 0.8 },
      { ...sample, charsChecked: 0, charsTotal: 0 },
    );
    expect(w.message).toContain("about 0% of its text");
  });
});
