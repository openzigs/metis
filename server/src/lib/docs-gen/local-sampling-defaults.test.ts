/**
 * #177 — local docs-gen sampling defaults are chosen per model FAMILY.
 *
 * `docsGenTuning("local")` used Gemma 4's model-card values (temperature 1.0,
 * top_p 0.95) for every local model. An independent evaluation measured 0.2 as
 * the best Phase-1 extraction setting on laguna-s-2.1, where 1.0 was in use.
 * Gemma keeps its model-card values; any other or unknown model gets the
 * conservative extraction setting. Explicit env still wins.
 *
 * The request-body half (temperature and top_p always sent on a local docs-gen
 * call, because Ollama's /v1 substitutes 1.0 for an omitted field) is asserted
 * against the real provider built by `buildDocsGenProvider`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDocsGenProvider, docsGenTuning } from "./holistic-synthesizer.js";
import {
  CONSERVATIVE_LOCAL_SAMPLING,
  GEMMA_LOCAL_SAMPLING,
  localSamplingDefaults,
  resolveLocalSampling,
} from "./local-sampling-defaults.js";

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_OFFLINE",
  "LOCAL_GEMMA_BASE_URL",
  "LOCAL_GEMMA_API_KEY",
  "LOCAL_GEMMA_MODEL",
  "DOCS_GEN_LOCAL_PHASE1_MODEL",
  "DOCS_GEN_LOCAL_PHASE2_MODEL",
  "DOCS_GEN_LOCAL_TEMPERATURE",
  "DOCS_GEN_LOCAL_TOP_P",
] as const;
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("localSamplingDefaults (#177)", () => {
  it.each(["gemma4:12b", "gemma3:4b", "google/gemma-3-27b-it", "hf.co/unsloth/Gemma-4-E4B:Q4"])(
    "%s is Gemma → model-card 1.0 / 0.95",
    (model) => {
      expect(localSamplingDefaults(model)).toEqual({ temperature: 1.0, topP: 0.95 });
    },
  );

  it.each(["laguna-s-2.1", "qwen2.5:14b", "Qwen/Qwen3-32B-AWQ", "phi4", "", "   "])(
    "%j is not Gemma → conservative 0.2 / 0.95",
    (model) => {
      expect(localSamplingDefaults(model)).toEqual({ temperature: 0.2, topP: 0.95 });
    },
  );

  it("exports the two value sets it chooses between", () => {
    expect(GEMMA_LOCAL_SAMPLING).toEqual({ temperature: 1.0, topP: 0.95 });
    expect(CONSERVATIVE_LOCAL_SAMPLING).toEqual({ temperature: 0.2, topP: 0.95 });
  });
});

describe("docsGenTuning('local') picks sampling by the configured model's family (#177)", () => {
  it("gemma model → 1.0 / 0.95", () => {
    process.env.LOCAL_GEMMA_MODEL = "gemma4:26b";
    const t = docsGenTuning("local", "");
    expect(t.temperature).toBe(1.0);
    expect(t.topP).toBe(0.95);
  });

  it("laguna → 0.2 / 0.95", () => {
    process.env.LOCAL_GEMMA_MODEL = "laguna-s-2.1";
    const t = docsGenTuning("local", "");
    expect(t.temperature).toBe(0.2);
    expect(t.topP).toBe(0.95);
  });

  it("an unknown model passed as the resolved config model → 0.2 / 0.95", () => {
    const t = docsGenTuning("local", "some-new-model:7b");
    expect(t.temperature).toBe(0.2);
    expect(t.topP).toBe(0.95);
  });

  it("DOCS_GEN_LOCAL_PHASE2_MODEL decides the family when set", () => {
    process.env.LOCAL_GEMMA_MODEL = "gemma4:26b";
    process.env.DOCS_GEN_LOCAL_PHASE2_MODEL = "laguna-s-2.1";
    expect(docsGenTuning("local", "").temperature).toBe(0.2);
  });

  it("explicit DOCS_GEN_LOCAL_TEMPERATURE / DOCS_GEN_LOCAL_TOP_P win over either family", () => {
    process.env.DOCS_GEN_LOCAL_TEMPERATURE = "0.7";
    process.env.DOCS_GEN_LOCAL_TOP_P = "0.8";
    process.env.LOCAL_GEMMA_MODEL = "laguna-s-2.1";
    expect(docsGenTuning("local", "")).toMatchObject({ temperature: 0.7, topP: 0.8 });
    process.env.LOCAL_GEMMA_MODEL = "gemma4:26b";
    expect(docsGenTuning("local", "")).toMatchObject({ temperature: 0.7, topP: 0.8 });
  });
});

describe("local docs-gen calls always send temperature and top_p (#177)", () => {
  /** Capture every request body the provider sends; answer with a minimal completion. */
  function captureBodies(): Array<Record<string, unknown>> {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return bodies;
  }

  it.each<[string, number]>([
    ["laguna-s-2.1", 0.2],
    ["gemma4:26b", 1.0],
  ])(
    "%s: phase 1 and phase 2 requests carry explicit temperature=%d and top_p",
    async (model, temp) => {
      process.env.AI_PROVIDER = "local-gemma";
      process.env.LOCAL_GEMMA_BASE_URL = "http://127.0.0.1:11434/v1";
      process.env.LOCAL_GEMMA_MODEL = model;
      process.env.DOCS_GEN_LOCAL_PHASE1_MODEL = model;
      const bodies = captureBodies();

      for (const phase of [1, 2] as const) {
        const { provider } = buildDocsGenProvider(phase, 256);
        expect(provider.key).toBe("local-gemma");
        await provider.chat([{ role: "user", content: "hi" }]);
      }

      expect(bodies).toHaveLength(2);
      for (const body of bodies) {
        expect(body.temperature).toBe(temp);
        expect(body.top_p).toBe(0.95);
      }
    },
  );
});

/**
 * PR #187 review M1 — Phase 1 and Phase 2 can serve DIFFERENT models (the
 * shipped Phase-1 default is `gemma3:4b`), so each phase's defaults must follow
 * the family of the model that phase actually serves.
 */
describe("sampling defaults are chosen per phase from that phase's own model (#177)", () => {
  async function phaseBodies(): Promise<Array<Record<string, unknown>>> {
    process.env.AI_PROVIDER = "local-gemma";
    process.env.LOCAL_GEMMA_BASE_URL = "http://127.0.0.1:11434/v1";
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    for (const phase of [1, 2] as const) {
      await buildDocsGenProvider(phase, 256).provider.chat([{ role: "user", content: "hi" }]);
    }
    return bodies;
  }

  it("gemma Phase 1 + laguna Phase 2 → Phase 1 at 1.0, Phase 2 at 0.2", async () => {
    process.env.DOCS_GEN_LOCAL_PHASE1_MODEL = "gemma3:4b";
    process.env.LOCAL_GEMMA_MODEL = "laguna-s-2.1";
    const [p1, p2] = await phaseBodies();
    expect(p1).toMatchObject({ model: "gemma3:4b", temperature: 1.0, top_p: 0.95 });
    expect(p2).toMatchObject({ model: "laguna-s-2.1", temperature: 0.2, top_p: 0.95 });
  });

  it("the shipped Phase-1 default (gemma3:4b) keeps Gemma values under a laguna Phase 2", async () => {
    process.env.LOCAL_GEMMA_MODEL = "laguna-s-2.1";
    const [p1, p2] = await phaseBodies();
    expect(p1).toMatchObject({ model: "gemma3:4b", temperature: 1.0 });
    expect(p2).toMatchObject({ model: "laguna-s-2.1", temperature: 0.2 });
  });

  it("laguna Phase 1 + gemma Phase 2 → Phase 1 at 0.2, Phase 2 at 1.0", async () => {
    process.env.DOCS_GEN_LOCAL_PHASE1_MODEL = "laguna-s-2.1";
    process.env.LOCAL_GEMMA_MODEL = "gemma4:26b";
    const [p1, p2] = await phaseBodies();
    expect(p1).toMatchObject({ model: "laguna-s-2.1", temperature: 0.2, top_p: 0.95 });
    expect(p2).toMatchObject({ model: "gemma4:26b", temperature: 1.0, top_p: 0.95 });
  });

  it("explicit DOCS_GEN_LOCAL_TEMPERATURE / TOP_P still win in both phases", async () => {
    process.env.DOCS_GEN_LOCAL_PHASE1_MODEL = "laguna-s-2.1";
    process.env.LOCAL_GEMMA_MODEL = "gemma4:26b";
    process.env.DOCS_GEN_LOCAL_TEMPERATURE = "0.6";
    process.env.DOCS_GEN_LOCAL_TOP_P = "0.9";
    const [p1, p2] = await phaseBodies();
    expect(p1).toMatchObject({ temperature: 0.6, top_p: 0.9 });
    expect(p2).toMatchObject({ temperature: 0.6, top_p: 0.9 });
  });

  it("the Phase-1 cache hash follows the Phase-1 model's sampling, not Phase 2's", () => {
    process.env.AI_PROVIDER = "local-gemma";
    process.env.LOCAL_GEMMA_BASE_URL = "http://127.0.0.1:11434/v1";
    process.env.DOCS_GEN_LOCAL_PHASE1_MODEL = "gemma3:4b";
    process.env.LOCAL_GEMMA_MODEL = "laguna-s-2.1";
    const underLaguna = buildDocsGenProvider(1, 256).effectiveConfigHash;
    process.env.LOCAL_GEMMA_MODEL = "gemma4:26b";
    // Same Phase-1 model → same sampling → same hash, whatever Phase 2 serves.
    expect(buildDocsGenProvider(1, 256).effectiveConfigHash).toBe(underLaguna);
  });
});

describe("resolveLocalSampling (#177)", () => {
  it("uses the family default when env is unset or not a number", () => {
    expect(resolveLocalSampling("laguna-s-2.1")).toEqual({ temperature: 0.2, topP: 0.95 });
    process.env.DOCS_GEN_LOCAL_TEMPERATURE = "warm";
    process.env.DOCS_GEN_LOCAL_TOP_P = "";
    expect(resolveLocalSampling("gemma4:26b")).toEqual({ temperature: 1.0, topP: 0.95 });
  });

  it("honours an explicit 0 (a valid, deterministic setting)", () => {
    process.env.DOCS_GEN_LOCAL_TEMPERATURE = "0";
    expect(resolveLocalSampling("gemma4:26b").temperature).toBe(0);
  });
});
