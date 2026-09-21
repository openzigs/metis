/**
 * Epic #108 — docs-gen quality knobs.
 *
 * Covers:
 *   - #116 provider-namespaced sampling/tuning defaults (local vs bedrock) and
 *     that the LOCAL_* and BEDROCK_* env namespaces never cross-contaminate.
 *   - #118 the refine flag gating (off by default, opt-in for local only).
 *   - Mermaid label repair (special characters that render as empty nodes).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  docsGenTuning,
  repairMermaidBlocks,
} from "../../../src/lib/docs-gen/holistic-synthesizer.js";

const DOCS_ENV_KEYS = [
  "DOCS_GEN_LOCAL_PHASE1_MODEL",
  "DOCS_GEN_LOCAL_PHASE2_MODEL",
  // Phase-2 resolution now reads LOCAL_GEMMA_MODEL directly, so clear it to keep
  // these default-behavior assertions hermetic. (local docs-gen model fix)
  "LOCAL_GEMMA_MODEL",
  "DOCS_GEN_LOCAL_FACTS_CHAR_CAP",
  "DOCS_GEN_LOCAL_TEMPERATURE",
  "DOCS_GEN_LOCAL_TOP_P",
  "DOCS_GEN_LOCAL_FREQ_PENALTY",
  "DOCS_GEN_LOCAL_REFINE",
  "DOCS_GEN_BEDROCK_PHASE1_MODEL",
  "DOCS_GEN_BEDROCK_PHASE2_MODEL",
  "DOCS_GEN_BEDROCK_FACTS_CHAR_CAP",
  "DOCS_GEN_BEDROCK_TEMPERATURE",
  "BEDROCK_MODEL",
] as const;

describe("docsGenTuning — provider-namespaced defaults (#116/#118)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of DOCS_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of DOCS_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("local defaults: Gemma sampling + small facts cap + refine OFF + verbose prompt", () => {
    const t = docsGenTuning("local", "gemma4:12b");
    expect(t.phase1Model).toBe("gemma3:4b");
    // When configModel is the bare reasoning default (gemma4:12b) and no
    // DOCS_GEN_LOCAL_PHASE2_MODEL / LOCAL_GEMMA_MODEL is set, phase 2 must NOT
    // silently use the reasoning model (it returns empty content via /v1) — it
    // resolves to the NON-reasoning fallback instead. (local docs-gen model fix)
    expect(t.phase2Model).toBe("gemma3:12b");
    expect(t.phase2Model).not.toBe("gemma4:12b");
    expect(t.factsCharCap).toBe(48_000);
    // Google model card mandates temperature=1.0 for all Gemma 4 use cases
    expect(t.temperature).toBe(1.0);
    expect(t.topP).toBe(0.95);
    // frequency_penalty intentionally undefined for Gemma 4 (MoE routing handles diversity)
    expect(t.frequencyPenalty).toBeUndefined();
    // thinking mode must be disabled (Ollama enables it by default, consuming token budget)
    expect(t.disableThinking).toBe(true);
    expect(t.refine).toBe(false);
    expect(t.concisePrompt).toBe(false);
    expect(t.supportsCaching).toBe(false);
  });

  it("bedrock defaults: NO top_p/frequency_penalty, large facts cap, refine OFF, caching ON", () => {
    const t = docsGenTuning("bedrock", "ignored");
    expect(t.factsCharCap).toBe(150_000);
    expect(t.temperature).toBe(0.2);
    expect(t.topP).toBeUndefined();
    expect(t.frequencyPenalty).toBeUndefined();
    expect(t.disableThinking).toBe(false);
    expect(t.refine).toBe(false);
    expect(t.supportsCaching).toBe(true);
  });

  it("LOCAL_* env overrides do NOT affect bedrock tuning", () => {
    process.env.DOCS_GEN_LOCAL_FACTS_CHAR_CAP = "12000";
    process.env.DOCS_GEN_LOCAL_TEMPERATURE = "0.42";
    process.env.DOCS_GEN_LOCAL_REFINE = "1";
    const local = docsGenTuning("local", "gemma4:12b");
    const bedrock = docsGenTuning("bedrock", "x");
    expect(local.factsCharCap).toBe(12_000);
    expect(local.temperature).toBe(0.42);
    expect(local.refine).toBe(true);
    // Bedrock untouched:
    expect(bedrock.factsCharCap).toBe(150_000);
    expect(bedrock.temperature).toBe(0.2);
    expect(bedrock.refine).toBe(false);
  });

  it("BEDROCK_* env overrides do NOT affect local tuning", () => {
    process.env.DOCS_GEN_BEDROCK_FACTS_CHAR_CAP = "200000";
    process.env.DOCS_GEN_BEDROCK_TEMPERATURE = "0.7";
    const local = docsGenTuning("local", "gemma4:12b");
    const bedrock = docsGenTuning("bedrock", "x");
    expect(bedrock.factsCharCap).toBe(200_000);
    expect(bedrock.temperature).toBe(0.7);
    // Local untouched:
    expect(local.factsCharCap).toBe(48_000);
    expect(local.temperature).toBe(1.0);
  });

  it("refine flag honours truthy values and defaults off", () => {
    expect(docsGenTuning("local", "m").refine).toBe(false);
    for (const v of ["1", "true", "YES", "on"]) {
      process.env.DOCS_GEN_LOCAL_REFINE = v;
      expect(docsGenTuning("local", "m").refine).toBe(true);
    }
    process.env.DOCS_GEN_LOCAL_REFINE = "0";
    expect(docsGenTuning("local", "m").refine).toBe(false);
  });
});

describe("repairMermaidBlocks — label safety", () => {
  it("quotes & inside an edge label", () => {
    const md = "```mermaid\ngraph LR\n  A -->|Search & Analysis| B\n```";
    const out = repairMermaidBlocks(md);
    expect(out).toContain('|"Search & Analysis"|');
  });

  it("quotes < inside a decision node label", () => {
    const md = "```mermaid\nflowchart TD\n  H{Retry Count < Max?}\n```";
    const out = repairMermaidBlocks(md);
    expect(out).toContain('{"Retry Count < Max?"}');
  });

  it("leaves --> arrows and clean labels untouched", () => {
    const md = "```mermaid\nflowchart TD\n  A[Start] --> B[Finish]\n```";
    const out = repairMermaidBlocks(md);
    expect(out).toBe(md);
  });

  it("does not double-quote an already-quoted label", () => {
    const md = '```mermaid\nflowchart TD\n  H{"already > safe"}\n```';
    const out = repairMermaidBlocks(md);
    expect(out).toBe(md);
  });

  it("quotes an unquoted bracket label with an embedded double-quote", () => {
    const md = '```mermaid\nflowchart TD\n  E[Throw Exception: "Invalid Data"]\n```';
    const out = repairMermaidBlocks(md);
    expect(out).toContain(`E["Throw Exception: 'Invalid Data'"]`);
  });

  it("quotes a colon in an unquoted bracket label", () => {
    const md = "```mermaid\ngraph TD\n  A --> B[Update State: SUCCESS]\n```";
    const out = repairMermaidBlocks(md);
    expect(out).toContain('B["Update State: SUCCESS"]');
  });

  it("quotes a colon in an unquoted decision label", () => {
    const md = "```mermaid\ngraph TD\n  A --> B{Return tooLarge: true}\n```";
    const out = repairMermaidBlocks(md);
    expect(out).toContain('B{"Return tooLarge: true"}');
  });

  it("strips trailing semicolon from the diagram type declaration", () => {
    const md = "```mermaid\ngraph TD;\n  A[Start] --> B[End]\n```";
    const out = repairMermaidBlocks(md);
    expect(out).toContain("graph TD\n");
    expect(out).not.toContain("graph TD;");
  });

  it("strips trailing semicolons from edge lines", () => {
    const md = "```mermaid\ngraph TD\n  A --> B[End];\n```";
    const out = repairMermaidBlocks(md);
    expect(out).not.toContain("];");
  });

  it("leaves a fully-quoted label containing & untouched", () => {
    const md = '```mermaid\nflowchart TD\n  V["Validate ID & Instructions"]\n```';
    const out = repairMermaidBlocks(md);
    expect(out).toBe(md);
  });

  it("leaves a database cylinder shape [(...)] untouched", () => {
    const md = "```mermaid\ngraph LR\n  Core --> DB[(Internal Database)]\n```";
    const out = repairMermaidBlocks(md);
    expect(out).toBe(md);
  });

  it("only touches content inside mermaid fences", () => {
    const md = "Prose with a < b and r & d.\n\n```mermaid\ngraph LR\n  A[ok] --> B[ok]\n```";
    const out = repairMermaidBlocks(md);
    expect(out.startsWith("Prose with a < b and r & d.")).toBe(true);
  });
});
