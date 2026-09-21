/**
 * Issue #1226 — output-cap resolution and assembled-document section checks.
 *
 * Two independent defects are covered here:
 *
 *   1. The docs-gen OUTPUT caps were hardcoded (8192 for a Phase-2 section,
 *      4096 for a Phase-1 fact extraction, plus the provider-level defaults
 *      they were passed as). A BRD section that needed more than the cap was
 *      cut off mid-sentence with no way for an operator to raise the ceiling.
 *      They are now registry-backed and read through the ConfigService, and are
 *      clamped DOWN to the model's known ceiling so raising the knob can never
 *      turn a working call into a provider 400.
 *
 *   2. `dedupeH2Sections` keeps only the FIRST block per H2 heading, so two
 *      section groups that lead with the same heading collapse into one and the
 *      second disappears from the document with no warning at all. The assembled
 *      body is now checked against what each group contributed.
 *
 * These are pure functions — no DB, no network, no live model.
 */
import { describe, it, expect } from "vitest";
import type { ConfigService } from "../config/config-service.js";
import type { AIProvider } from "../ai/types.js";
import { ClaimExtractor } from "./grounding/claim-extractor.js";
import { FaithfulnessJudge } from "./grounding/faithfulness-judge.js";
import { buildGroundingContext } from "./grounding/grounding-context.js";
import {
  DEFAULT_FACTS_MAX_OUTPUT_TOKENS,
  DEFAULT_SECTION_MAX_OUTPUT_TOKENS,
  collectH2Headings,
  detectMissingSections,
  firstH2Heading,
  modelOutputCeiling,
  resolveFactsMaxOutputTokens,
  resolveSectionMaxOutputTokens,
} from "./holistic-synthesizer.js";

/** A ConfigService stub that returns fixed values for the two output-cap keys. */
function stubConfig(values: Record<string, number> = {}): ConfigService {
  return {
    getNumber: (key: string, defaultValue?: number) => values[key] ?? defaultValue,
  } as unknown as ConfigService;
}

const SECTION_KEY = "DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS";
const FACTS_KEY = "DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS";
/** A Claude 4-generation id — a 64000-token ceiling, well above the default. */
const CLAUDE_4 = "us.anthropic.claude-sonnet-4-20250514-v1:0";
/** The Haiku profile both grounding-model registry keys recommend. */
const HAIKU = "us.anthropic.claude-3-5-haiku-20241022-v1:0";

describe("modelOutputCeiling (#1226)", () => {
  it("caps Claude 3.5 Haiku at its 8192-token output ceiling", () => {
    expect(modelOutputCeiling("anthropic.claude-3-5-haiku-20241022-v1:0")).toBe(8192);
  });

  it("caps Claude 3 Sonnet at its 4096-token output ceiling", () => {
    expect(modelOutputCeiling("anthropic.claude-3-sonnet-20240229-v1:0")).toBe(4096);
  });

  it("allows the far larger ceiling on Claude 4-generation models", () => {
    expect(modelOutputCeiling("us.anthropic.claude-sonnet-4-20250514-v1:0")).toBe(64000);
  });

  it("returns null for an unknown model so no clamp is applied", () => {
    expect(modelOutputCeiling("some-local-gemma-27b")).toBeNull();
  });

  it("returns null when no model is known at all", () => {
    expect(modelOutputCeiling(undefined)).toBeNull();
  });
});

describe("resolveSectionMaxOutputTokens (#1226)", () => {
  it("defaults far above the old hardcoded 8192 cap on a model known to allow it", () => {
    expect(resolveSectionMaxOutputTokens(CLAUDE_4, stubConfig())).toBe(
      DEFAULT_SECTION_MAX_OUTPUT_TOKENS,
    );
    expect(DEFAULT_SECTION_MAX_OUTPUT_TOKENS).toBeGreaterThan(8192);
  });

  it("keeps the pre-#1226 default for a model with no known ceiling", () => {
    // Nova / Llama / Mistral / a local runtime accepted 8192 before the default
    // was raised; several would reject 32768 outright.
    expect(resolveSectionMaxOutputTokens("amazon.nova-pro-v1:0", stubConfig())).toBe(8192);
    expect(resolveSectionMaxOutputTokens(undefined, stubConfig())).toBe(8192);
  });

  it("honours an operator override from the config registry", () => {
    const cap = resolveSectionMaxOutputTokens(undefined, stubConfig({ [SECTION_KEY]: 20_000 }));
    expect(cap).toBe(20_000);
  });

  it("clamps an over-ambitious override down to the model's ceiling", () => {
    const cap = resolveSectionMaxOutputTokens(
      "anthropic.claude-3-5-haiku-20241022-v1:0",
      stubConfig({ [SECTION_KEY]: 100_000 }),
    );
    expect(cap).toBe(8192);
  });

  it("ignores an absurdly small override and falls back to the default", () => {
    const cap = resolveSectionMaxOutputTokens(CLAUDE_4, stubConfig({ [SECTION_KEY]: 8 }));
    expect(cap).toBe(DEFAULT_SECTION_MAX_OUTPUT_TOKENS);
  });

  it("leaves an unknown model unclamped so a local model is not throttled", () => {
    const cap = resolveSectionMaxOutputTokens(
      "local-gemma-27b",
      stubConfig({ [SECTION_KEY]: 40_000 }),
    );
    expect(cap).toBe(40_000);
  });
});

describe("resolveFactsMaxOutputTokens (#1226)", () => {
  it("defaults above the old hardcoded 4096 cap", () => {
    expect(resolveFactsMaxOutputTokens(undefined, stubConfig())).toBe(
      DEFAULT_FACTS_MAX_OUTPUT_TOKENS,
    );
    expect(DEFAULT_FACTS_MAX_OUTPUT_TOKENS).toBeGreaterThan(4096);
  });

  it("honours its own key independently of the section cap", () => {
    const cap = resolveFactsMaxOutputTokens(
      undefined,
      stubConfig({ [SECTION_KEY]: 30_000, [FACTS_KEY]: 12_000 }),
    );
    expect(cap).toBe(12_000);
  });

  it("clamps down to the model ceiling like the section cap does", () => {
    const cap = resolveFactsMaxOutputTokens(
      "anthropic.claude-3-haiku-20240307-v1:0",
      stubConfig({ [FACTS_KEY]: 50_000 }),
    );
    expect(cap).toBe(4096);
  });
});

/**
 * #1226 regression — the grounders run a DIFFERENT model than the Phase-2
 * section model whose cap became the provider's `defaultMaxTokens`. A
 * `chat()` call that passes no explicit `maxTokens` inherits that default, so
 * pointing `DOCS_GEN_BEDROCK_CLAIM_MODEL` / `DOCS_GEN_GROUNDING_MODEL` at the
 * recommended Haiku profile would request a section-sized budget from a model
 * with an 8192 ceiling — a hard provider 400, not a silent truncation.
 */
describe("grounding-path output caps (#1226)", () => {
  const haikuCeiling = modelOutputCeiling(HAIKU) ?? 0;

  interface CapturedCall {
    model?: string;
    maxTokens?: number;
  }

  function capturingProvider(content: string): { provider: AIProvider; calls: CapturedCall[] } {
    const calls: CapturedCall[] = [];
    const provider = {
      key: "bedrock",
      // Built for the Phase-2 SECTION model — deliberately not the Haiku the
      // grounders run.
      model: CLAUDE_4,
      offline: false,
      chat: async (_messages: unknown, opts: CapturedCall) => {
        calls.push(opts);
        return {
          content,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: CLAUDE_4,
          provider: "bedrock",
          offline: false,
        };
      },
    } as unknown as AIProvider;
    return { provider, calls };
  }

  const ctx = buildGroundingContext({
    ragChunks: [
      {
        documentId: "doc1",
        chunkId: "c1",
        filename: "Billing.java",
        text: "Invoices over 1000 need approval.",
      },
    ],
  });

  it("keeps the inherited provider default within a Haiku grounding model's ceiling", () => {
    // This is the value passed as `defaultMaxTokens` when the Phase-2 bundle is
    // built, and therefore the cap any grounding call falls back to.
    expect(haikuCeiling).toBe(8192);
    expect(resolveSectionMaxOutputTokens(undefined, stubConfig())).toBeLessThanOrEqual(
      haikuCeiling,
    );
  });

  it("caps claim extraction at the CLAIM model's ceiling", async () => {
    const { provider, calls } = capturingProvider('{"claims":[]}');
    const extractor = new ClaimExtractor({
      provider,
      model: HAIKU,
      maxTokens: resolveSectionMaxOutputTokens(HAIKU, stubConfig()),
    });
    await extractor.decompose("Invoices over 1000 require approval.", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(HAIKU);
    expect(calls[0].maxTokens).toBeLessThanOrEqual(haikuCeiling);
  });

  it("caps faithfulness judging at the JUDGE model's ceiling", async () => {
    const { provider, calls } = capturingProvider('{"verdicts":[]}');
    const judge = new FaithfulnessJudge({
      provider,
      model: HAIKU,
      maxTokens: resolveSectionMaxOutputTokens(HAIKU, stubConfig()),
    });
    await judge.judgeBatch(["Invoices over 1000 require approval."], "evidence");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(HAIKU);
    expect(calls[0].maxTokens).toBeLessThanOrEqual(haikuCeiling);
  });
});

describe("firstH2Heading (#1226)", () => {
  it("returns the first H2 heading text", () => {
    expect(firstH2Heading("## Key Workflows\n\nProse.\n\n## Later\n")).toBe("Key Workflows");
  });

  it("ignores a '##' line inside a fenced code block", () => {
    const md = "```bash\n## not a heading\n```\n\n## Real Heading\n";
    expect(firstH2Heading(md)).toBe("Real Heading");
  });

  it("returns null when the section has no H2 at all", () => {
    expect(firstH2Heading("Just prose with no headings.")).toBeNull();
  });

  it("does not treat an H3 as an H2", () => {
    expect(firstH2Heading("### Sub only\n\nProse.")).toBeNull();
  });
});

describe("collectH2Headings (#1226)", () => {
  it("collects every H2 heading in the assembled body", () => {
    const body = "## One\n\na\n\n## Two\n\nb\n\n### Three\n";
    expect(collectH2Headings(body)).toEqual(["One", "Two"]);
  });

  it("skips headings inside fenced code blocks", () => {
    const body = "## Real\n\n```md\n## Fake\n```\n";
    expect(collectH2Headings(body)).toEqual(["Real"]);
  });

  it("keeps repeats so a collapsed duplicate is detectable", () => {
    expect(collectH2Headings("## Same\n\na\n\n## Same\n\nb\n")).toEqual(["Same", "Same"]);
  });
});

describe("detectMissingSections (#1226)", () => {
  it("reports nothing when every contributing group survived assembly", () => {
    const contributed = [
      { label: "Key Workflows", heading: "Key Workflows" },
      { label: "Data & Domain Model", heading: "Data Model" },
    ];
    const body = "## Key Workflows\n\na\n\n## Data Model\n\nb\n";
    expect(detectMissingSections(contributed, body)).toEqual([]);
  });

  it("reports the group whose heading was collapsed by de-duplication", () => {
    const contributed = [
      { label: "Business Rules", heading: "Business Rules" },
      { label: "Key Workflows", heading: "Business Rules" },
    ];
    // dedupeH2Sections keeps the first block only — the second group vanishes
    // even though its heading text is still present in the document.
    const body = "## Business Rules\n\nfirst only\n";
    const warnings = detectMissingSections(contributed, body);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("section-missing");
    expect(warnings[0].severity).toBe("error");
    expect(warnings[0].message).toContain("Key Workflows");
  });

  it("reports a group that produced no H2 heading to locate it by", () => {
    const contributed = [{ label: "Integrations & Glossary", heading: null }];
    const warnings = detectMissingSections(contributed, "## Something Else\n");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].kind).toBe("section-missing");
    expect(warnings[0].message).toContain("Integrations & Glossary");
  });

  it("reports nothing when no group contributed at all", () => {
    expect(detectMissingSections([], "")).toEqual([]);
  });
});
