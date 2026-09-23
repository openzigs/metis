/**
 * Issue #337 — right-size local tuning knobs: validation + guardrails.
 *
 * The local tuning knobs already EXIST and are env-configurable via
 * `docsGenTuning('local', …)`. This suite is the regression guard for the
 * remaining gaps:
 *
 *  1. env → tuning: every `DOCS_GEN_LOCAL_*` knob maps to the resolved tuning
 *     value (and the documented defaults are unchanged when env is unset).
 *  2. facts-cap truncation is OBSERVABLE, not silent: `summarizeFactsBudget`
 *     reports omission when relevant facts exceed `factsCharCap`, and reports no
 *     omission when they fit — the signal the synthesis loop turns into a
 *     `facts-truncated` DocWarning (local) / a telemetry log (all providers).
 *
 * `docsGenTuning` and `summarizeFactsBudget` read env/inputs at call time, so
 * each test sets/clears the relevant vars and asserts the resolved value.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  docsGenTuning,
  summarizeFactsBudget,
  sectionGroupsFor,
  type ModuleFacts,
} from "./holistic-synthesizer.js";

const LOCAL_ENV_KEYS = [
  "DOCS_GEN_LOCAL_FACTS_CHAR_CAP",
  "DOCS_GEN_LOCAL_TEMPERATURE",
  "DOCS_GEN_LOCAL_TOP_P",
  "DOCS_GEN_LOCAL_ENABLE_THINKING",
  "DOCS_GEN_LOCAL_REFINE",
  "DOCS_GEN_LOCAL_CONCISE_PROMPT",
  "DOCS_GEN_LOCAL_PHASE1_MODEL",
  "DOCS_GEN_LOCAL_PHASE2_MODEL",
  "LOCAL_GEMMA_MODEL",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of LOCAL_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of LOCAL_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("docsGenTuning('local') — documented defaults (unchanged)", () => {
  it("uses the documented defaults when no env override is set", () => {
    const t = docsGenTuning("local", "");
    // Cap default: 48000 chars (~14K tokens, sized for the ~32K local window).
    expect(t.factsCharCap).toBe(48_000);
    // Gemma-4 mandate: temperature 1.0 / top_p 0.95 (lower temp → empty content).
    expect(t.temperature).toBe(1.0);
    expect(t.topP).toBe(0.95);
    // Thinking is DISABLED by default (Ollama Gemma template enables it → empty).
    expect(t.disableThinking).toBe(true);
    // Refine + concise prompt are opt-in.
    expect(t.refine).toBe(false);
    expect(t.concisePrompt).toBe(false);
  });
});

describe("docsGenTuning('local') — env → tuning knob mapping (#337)", () => {
  it("DOCS_GEN_LOCAL_FACTS_CHAR_CAP maps to factsCharCap (fit the measured window)", () => {
    // e.g. a 14B on a tight 24 GB TP=2 box measured a smaller effective window.
    process.env.DOCS_GEN_LOCAL_FACTS_CHAR_CAP = "24000";
    expect(docsGenTuning("local", "").factsCharCap).toBe(24_000);
  });

  it("clamps DOCS_GEN_LOCAL_FACTS_CHAR_CAP below its 4000 floor back to the default", () => {
    // Below the floor is treated as invalid → documented default, never a
    // near-zero cap that would starve every section.
    process.env.DOCS_GEN_LOCAL_FACTS_CHAR_CAP = "100";
    expect(docsGenTuning("local", "").factsCharCap).toBe(48_000);
  });

  it("DOCS_GEN_LOCAL_TEMPERATURE maps to temperature (near-deterministic for dense models)", () => {
    // Qwen3 / Phi-4 dense models prefer ~0 for faithful literal/reconstruction.
    process.env.DOCS_GEN_LOCAL_TEMPERATURE = "0";
    expect(docsGenTuning("local", "").temperature).toBe(0);
  });

  it("DOCS_GEN_LOCAL_TOP_P maps to topP", () => {
    process.env.DOCS_GEN_LOCAL_TOP_P = "0.8";
    expect(docsGenTuning("local", "").topP).toBe(0.8);
  });

  it("DOCS_GEN_LOCAL_ENABLE_THINKING flips disableThinking off (opt-in reasoning)", () => {
    process.env.DOCS_GEN_LOCAL_ENABLE_THINKING = "1";
    expect(docsGenTuning("local", "").disableThinking).toBe(false);
  });

  it("DOCS_GEN_LOCAL_REFINE and DOCS_GEN_LOCAL_CONCISE_PROMPT are opt-in flags", () => {
    process.env.DOCS_GEN_LOCAL_REFINE = "true";
    process.env.DOCS_GEN_LOCAL_CONCISE_PROMPT = "yes";
    const t = docsGenTuning("local", "");
    expect(t.refine).toBe(true);
    expect(t.concisePrompt).toBe(true);
  });

  it("an invalid/non-numeric temperature falls back to the Gemma-safe default (1.0)", () => {
    process.env.DOCS_GEN_LOCAL_TEMPERATURE = "not-a-number";
    expect(docsGenTuning("local", "").temperature).toBe(1.0);
  });

  it("LOCAL_* knobs never leak into the bedrock provider tuning", () => {
    process.env.DOCS_GEN_LOCAL_FACTS_CHAR_CAP = "24000";
    process.env.DOCS_GEN_LOCAL_TEMPERATURE = "0";
    const bedrock = docsGenTuning("bedrock", "us.anthropic.claude-sonnet-4-6");
    expect(bedrock.factsCharCap).toBe(150_000);
    expect(bedrock.temperature).toBe(0.2);
  });
});

/** Build a module whose facts entry is ~`facts` chars, for cap tests. */
function moduleWith(name: string, factsLen: number): ModuleFacts {
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 10, // constant so relevance score ties → cap alone drives omission
    // Fill the WORKFLOWS slice so selectRelevantFacts scores it. Bullets are
    // distinct: #154 slicing keeps a verbatim-repeated bullet only once.
    facts: `WORKFLOWS\n${Array.from({ length: Math.max(1, Math.floor(factsLen / 10)) }, (_, i) => `- step ${i}`).join("\n")}`,
    formulas: [],
    topClasses: [name],
  };
}

describe("summarizeFactsBudget (#337) — facts-cap truncation is observable", () => {
  const group = sectionGroupsFor("business-requirements").find((g) => /workflow/i.test(g.id))!;

  it("reports no omission when the relevant facts fit under the cap", () => {
    // Two small modules well under a generous cap.
    const facts = [moduleWith("a", 500), moduleWith("b", 500)];
    const summary = summarizeFactsBudget(facts, group, "business-requirements", 48_000);
    expect(summary.exceeded).toBe(false);
    expect(summary.omittedModules).toBe(0);
    expect(summary.includedModules).toBe(2);
    expect(summary.factsCharCap).toBe(48_000);
  });

  it("reports omission (exceeded=true) when the facts overflow a tight cap", () => {
    // Several large modules against a deliberately tight cap → some are dropped.
    const facts = [
      moduleWith("a", 4_000),
      moduleWith("b", 4_000),
      moduleWith("c", 4_000),
      moduleWith("d", 4_000),
    ];
    const summary = summarizeFactsBudget(facts, group, "business-requirements", 6_000);
    expect(summary.exceeded).toBe(true);
    expect(summary.omittedModules).toBeGreaterThan(0);
    expect(summary.includedModules + summary.omittedModules).toBe(4);
    // The included facts never exceed the cap they were selected against.
    expect(summary.includedChars).toBeLessThanOrEqual(6_000);
  });

  it("raising the cap admits more modules (fewer omitted) — the #337 remedy", () => {
    const facts = [
      moduleWith("a", 4_000),
      moduleWith("b", 4_000),
      moduleWith("c", 4_000),
      moduleWith("d", 4_000),
    ];
    const tight = summarizeFactsBudget(facts, group, "business-requirements", 6_000);
    const roomy = summarizeFactsBudget(facts, group, "business-requirements", 48_000);
    expect(roomy.omittedModules).toBeLessThan(tight.omittedModules);
    expect(roomy.exceeded).toBe(false);
  });

  it("empty facts never report truncation", () => {
    const summary = summarizeFactsBudget([], group, "business-requirements", 48_000);
    expect(summary.exceeded).toBe(false);
    expect(summary.includedModules).toBe(0);
    expect(summary.omittedModules).toBe(0);
  });
});
