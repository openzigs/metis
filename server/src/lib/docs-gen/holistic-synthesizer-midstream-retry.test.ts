/**
 * #114 — a LOCAL section whose stream drops mid-response is retried once,
 * immediately, with the identical prompt.
 *
 * Observed live 2026-09-23: a 79,608-token section was 1,260 tokens into its
 * answer when the connection between METIS and the Ollama host dropped. The
 * runtime (llama-server) saved the prompt to its cache on cancel, so a retry
 * would have skipped almost all of the ~6 min prefill; METIS failed the section
 * instead. A drop BEFORE the first chunk, any other error, and a cloud provider
 * keep the old behaviour — the first-byte case is #111's and is never retried.
 *
 * Drives the real synthesis loop with a provider double whose stream follows a
 * per-call script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  MID_STREAM_DROP_ATTEMPTS,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";
import { GENERATION_PROVIDER_DROPPED_MESSAGE } from "./generation-failure-message.js";

const db = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  codeGraph: { findMany: vi.fn() },
  codeSymbol: { findMany: vi.fn(), groupBy: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
vi.mock("../finops/index.js", () => ({ recordUsage: vi.fn() }));

type Step = "ok" | "drop-mid" | "drop-before" | "boom-mid" | "reset-mid";

/** One step per SECTION stream call, in order; exhausted → "ok". */
const state: { plan: Step[]; sectionCalls: string[] } = { plan: [], sectionCalls: [] };

/** undici's mid-stream failure: `TypeError: terminated`, socket error under `.cause`. */
function terminated(): TypeError {
  return new TypeError("terminated", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

function makeProvider(key: string): AIProvider {
  return {
    key,
    model: "fixture",
    offline: false,
    chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    async *stream(messages: Array<{ content: unknown }>): AsyncGenerator<ChatChunk> {
      const prompt = String(messages.at(-1)?.content);
      if (!prompt.includes("section group now")) {
        yield { type: "delta", content: "PURPOSE\n- Source facts." };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      state.sectionCalls.push(JSON.stringify(messages));
      const step = state.plan.shift() ?? "ok";
      if (step === "drop-before") throw terminated();
      const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)![1];
      yield { type: "delta", content: `## ${label}\n\nSource ` };
      if (step === "drop-mid") throw terminated();
      if (step === "reset-mid") {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        });
      }
      if (step === "boom-mid") throw new Error("model produced garbage");
      yield { type: "delta", content: "facts." };
      yield { type: "done", finishReason: "stop" };
    },
  } as unknown as AIProvider;
}

const meta = { name: "Project", language: "typescript", totalFiles: 1, totalSymbols: 3 };
const facts: ModuleFacts[] = [
  {
    modulePath: "src/orders",
    moduleName: "orders",
    classCount: 1,
    methodCount: 2,
    facts: "Validate orders.",
    formulas: [],
    topClasses: ["Order"],
  },
];
const groups = sectionGroupsFor("architecture");

function router(kind: "local" | "bedrock"): Phase2Router {
  const provider = makeProvider(kind === "local" ? "local-gemma" : "bedrock-gateway");
  const tuning = docsGenTuning(kind, "fixture");
  return {
    primary: { kind, provider, tuning, factsCharCap: tuning.factsCharCap, supportsCaching: false },
    hybrid: null,
  };
}

function synth(kind: "local" | "bedrock") {
  return synthesizeFinalDocument(
    facts,
    meta,
    "architecture",
    "Architecture",
    router(kind),
    "p",
    undefined as GroundingContext | undefined,
  );
}

const failed = (r: Awaited<ReturnType<typeof synth>>) =>
  r.warnings.filter((w) => w.kind === "section-failed");

beforeEach(() => {
  state.plan = [];
  state.sectionCalls = [];
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("DOCS_GEN_LOCAL_REFINE", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local section mid-stream drop is retried once with the identical prompt (#114)", () => {
  it("retries a `terminated` drop after the first chunk, and the section succeeds", async () => {
    state.plan = ["drop-mid"];
    const result = await synth("local");
    expect(failed(result)).toEqual([]);
    // One extra call — the retry — on top of one per section.
    expect(state.sectionCalls).toHaveLength(groups.length + 1);
    // The retry re-sent the byte-identical prompt, so the runtime's prompt cache hits.
    expect(state.sectionCalls[1]).toBe(state.sectionCalls[0]);
    // The kept text is the retry's complete answer, not the partial first attempt.
    expect(result.markdown).toContain("Source facts.");
  });

  it("retries an ECONNRESET mid-stream too", async () => {
    state.plan = ["reset-mid"];
    const result = await synth("local");
    expect(failed(result)).toEqual([]);
    expect(state.sectionCalls).toHaveLength(groups.length + 1);
  });

  it("retries only once: a second drop fails the section with the drop message", async () => {
    state.plan = ["drop-mid", "drop-mid"];
    const result = await synth("local");
    expect(MID_STREAM_DROP_ATTEMPTS).toBe(2);
    const f = failed(result);
    expect(f).toHaveLength(1);
    expect(f[0].message).toContain(GENERATION_PROVIDER_DROPPED_MESSAGE);
    expect(state.sectionCalls).toHaveLength(groups.length + 1);
  });

  it("does NOT retry a drop before the first chunk (the prefill never finished)", async () => {
    state.plan = ["drop-before"];
    const result = await synth("local");
    expect(failed(result)).toHaveLength(1);
    expect(state.sectionCalls).toHaveLength(groups.length);
  });

  it("does NOT retry a mid-stream error that is not a connection drop", async () => {
    state.plan = ["boom-mid"];
    const result = await synth("local");
    expect(failed(result)).toHaveLength(1);
    expect(state.sectionCalls).toHaveLength(groups.length);
  });

  it("does NOT retry on a cloud provider", async () => {
    state.plan = ["drop-mid"];
    const result = await synth("bedrock");
    expect(failed(result)).toHaveLength(1);
    expect(state.sectionCalls).toHaveLength(groups.length);
  });
});
