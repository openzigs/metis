/**
 * #114 / #1174 — a section whose stream drops PART-WAY through a reply is
 * retried with the identical prompt, on every provider, a bounded number of
 * times with backoff.
 *
 * #114 (observed live 2026-09-23): a 79,608-token local section was 1,260
 * tokens into its answer when the connection to the Ollama host dropped; the
 * runtime saved the prompt to its cache on cancel, so a retry skips the prefill.
 * #1174 (walkthrough run 9): a cloud BRD section failed with
 * `anthropic stream failed (TypeError): terminated` and the document ended
 * degraded — the retry used to be local-only.
 *
 * Not retried: a drop BEFORE the first chunk (#111's first-byte case), a
 * cancelled run, a configuration error, a 4xx, and any other error.
 *
 * Drives the real synthesis loop with a provider double whose stream follows a
 * per-call script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";
import { AIConfigError, AIProviderError } from "../ai/errors.js";
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
import { GenerationControl, scopedToGeneration } from "./generation-control.js";
import { withGenerationScope } from "./generation-scope.js";
import { UnpublishableGenerationError } from "./generation-checkpoint.js";

const db = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  codeGraph: { findMany: vi.fn() },
  codeSymbol: { findMany: vi.fn(), groupBy: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
const finops = vi.hoisted(() => ({ recordUsage: vi.fn() }));
vi.mock("../finops/index.js", () => finops);

// The backoff wait: recorded, and resolved at once so the suite stays fast. A
// test can swap the implementation to observe a cancel mid-wait.
const sleeper = vi.hoisted(() => ({
  impl: async (_ms: number, _signal?: AbortSignal): Promise<void> => {},
  calls: [] as Array<{ ms: number; signal?: AbortSignal }>,
}));
vi.mock("./grounding/transient-retry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./grounding/transient-retry.js")>();
  return {
    ...actual,
    abortableSleep: (ms: number, signal?: AbortSignal) => {
      sleeper.calls.push({ ms, signal });
      return sleeper.impl(ms, signal);
    },
  };
});

type Step =
  | "ok"
  | "drop-mid"
  | "drop-before"
  | "boom-mid"
  | "reset-mid"
  | "anthropic-drop-mid"
  | "drop-mid-after-usage"
  | "anthropic-400-mid"
  | "config-mid"
  | "client-error-reset-mid"
  | "body-timeout-mid"
  | "stop-then-drop";

/** One step per SECTION stream call, in order; exhausted → "ok". */
const state: { plan: Step[]; sectionCalls: string[]; stopRun?: () => void } = {
  plan: [],
  sectionCalls: [],
};

/** undici's mid-stream failure: `TypeError: terminated`, socket error under `.cause`. */
function terminated(): TypeError {
  return new TypeError("terminated", {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

/** The same drop as the Anthropic adapter wraps it (`mapError`, stamped 502) — run 9's error. */
function anthropicTerminated(): AIProviderError {
  return new AIProviderError("anthropic stream failed (TypeError): terminated", 502, {
    provider: "anthropic",
    operation: "stream",
    errorName: "TypeError",
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
      if (step === "anthropic-drop-mid") throw anthropicTerminated();
      if (step === "drop-mid-after-usage") {
        yield {
          type: "usage",
          usage: { promptTokens: 100_000, completionTokens: 5, totalTokens: 100_005 },
        };
        throw anthropicTerminated();
      }
      if (step === "anthropic-400-mid") {
        throw new AIProviderError(
          "anthropic stream failed (BadRequestError): 400 prompt is too long",
          400,
        );
      }
      if (step === "config-mid") throw new AIConfigError("ANTHROPIC_API_KEY is not set");
      if (step === "client-error-reset-mid") {
        // Reads as a drop to `isConnectionDropped` (an ECONNRESET under it), but
        // the server's answer was a 4xx: never a drop (NEVER_A_DROP).
        throw Object.assign(
          new AIProviderError("anthropic stream failed (BadRequestError): 400 bad request", 400),
          { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) },
        );
      }
      if (step === "stop-then-drop") {
        yield {
          type: "usage",
          usage: { promptTokens: 77_777, completionTokens: 7, totalTokens: 77_784 },
        };
        state.stopRun?.();
        throw terminated();
      }
      if (step === "reset-mid") {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        });
      }
      if (step === "body-timeout-mid") {
        // undici gave up waiting for more of the body: `terminated`, as a drop
        // reads, but with a BodyTimeoutError under it.
        throw new TypeError("terminated", {
          cause: Object.assign(new Error("Body Timeout Error"), {
            name: "BodyTimeoutError",
            code: "UND_ERR_BODY_TIMEOUT",
          }),
        });
      }
      if (step === "boom-mid") throw new Error("model produced garbage");
      yield { type: "delta", content: "facts." };
      yield {
        type: "usage",
        usage: { promptTokens: 1000, completionTokens: 20, totalTokens: 1020 },
      };
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

type Kind = "local" | "bedrock" | "anthropic";

function router(kind: Kind, opts: { scoped?: boolean } = {}): Phase2Router {
  const key =
    kind === "local" ? "local-gemma" : kind === "anthropic" ? "anthropic" : "bedrock-gateway";
  // `scoped` wraps the provider as production does (`scopedToGeneration`), so a
  // call the run aborted is recorded by the wrapper.
  const raw = makeProvider(key);
  const provider = opts.scoped ? scopedToGeneration(raw) : raw;
  const tuningKind = kind === "local" ? "local" : "bedrock";
  const tuning = docsGenTuning(tuningKind, "fixture");
  return {
    primary: {
      kind: tuningKind,
      provider,
      tuning,
      factsCharCap: tuning.factsCharCap,
      supportsCaching: false,
    },
    hybrid: null,
  };
}

function synth(kind: Kind, opts: { scoped?: boolean } = {}) {
  return synthesizeFinalDocument(
    facts,
    meta,
    "architecture",
    "Architecture",
    router(kind, opts),
    "p",
    undefined as GroundingContext | undefined,
  );
}

const failed = (r: Awaited<ReturnType<typeof synth>>) =>
  r.warnings.filter((w) => w.kind === "section-failed");

/** The section-draft rows written to the ledger, by session id. */
const draftUsageRows = () =>
  finops.recordUsage.mock.calls
    .map(([row]) => row as { sessionId: string; agentStep: string; inputTokens: number })
    .filter((row) => row.sessionId.includes("-draft-"));

beforeEach(() => {
  state.plan = [];
  state.sectionCalls = [];
  state.stopRun = undefined;
  sleeper.calls = [];
  sleeper.impl = async () => {};
  finops.recordUsage.mockReset();
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("DOCS_GEN_LOCAL_REFINE", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local section mid-stream drop is retried with the identical prompt (#114)", () => {
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

  it("is bounded: a drop on every attempt fails the section with the drop message", async () => {
    expect(MID_STREAM_DROP_ATTEMPTS).toBe(3);
    state.plan = Array<Step>(MID_STREAM_DROP_ATTEMPTS).fill("drop-mid");
    const result = await synth("local");
    const f = failed(result);
    expect(f).toHaveLength(1);
    // #1209 — says the connection dropped, and how many times it was tried.
    expect(f[0].message).toContain(
      "the AI provider's connection dropped while it was writing this section (3 attempts)",
    );
    expect(f[0].message).not.toContain(GENERATION_PROVIDER_DROPPED_MESSAGE);
    expect(state.sectionCalls).toHaveLength(groups.length + MID_STREAM_DROP_ATTEMPTS - 1);
    // A backoff before each retry, none after the last attempt.
    expect(sleeper.calls).toHaveLength(MID_STREAM_DROP_ATTEMPTS - 1);
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
});

describe("a cloud section whose stream drops mid-reply is retried with backoff (#1174)", () => {
  it("retries run 9's wrapped Anthropic `terminated` drop, and the section succeeds", async () => {
    state.plan = ["anthropic-drop-mid"];
    const result = await synth("anthropic");
    expect(failed(result)).toEqual([]);
    expect(state.sectionCalls).toHaveLength(groups.length + 1);
    expect(state.sectionCalls[1]).toBe(state.sectionCalls[0]);
    expect(result.markdown).toContain("Source facts.");
    // It waited before asking again.
    expect(sleeper.calls).toHaveLength(1);
    expect(sleeper.calls[0].ms).toBeGreaterThan(0);
  });

  it("retries an undici drop on the Bedrock gateway too", async () => {
    state.plan = ["drop-mid"];
    const result = await synth("bedrock");
    expect(failed(result)).toEqual([]);
    expect(state.sectionCalls).toHaveLength(groups.length + 1);
  });

  it("#1209 — a drop on every attempt fails the section, saying the connection dropped and how often it was tried", async () => {
    state.plan = Array<Step>(MID_STREAM_DROP_ATTEMPTS).fill("anthropic-drop-mid");
    const result = await synth("anthropic");
    const f = failed(result);
    expect(f).toHaveLength(1);
    // Not "an unrecognised error (AIProviderError)": the Anthropic adapter's
    // wrapped drop is read as one, and the attempt count is passed through.
    expect(f[0].message).toBe(
      `Section "${groups[0].label}" could not be generated: the AI provider's connection dropped while it was writing this section (3 attempts). Regenerate the document to try this section again; the finished sections are reused.`,
    );
    expect(state.sectionCalls).toHaveLength(groups.length + MID_STREAM_DROP_ATTEMPTS - 1);
  });

  it.each<[string, Step]>([
    ["a 4xx", "anthropic-400-mid"],
    ["a configuration error", "config-mid"],
    ["a 4xx whose cause reads as a connection reset", "client-error-reset-mid"],
    ["an error that is not a drop", "boom-mid"],
    ["a drop before the first chunk", "drop-before"],
    ["#1209 — a body timeout, which reads as `terminated`", "body-timeout-mid"],
  ])("does NOT retry %s", async (_label, step) => {
    state.plan = [step];
    const result = await synth("anthropic");
    expect(failed(result)).toHaveLength(1);
    expect(state.sectionCalls).toHaveLength(groups.length);
    expect(sleeper.calls).toHaveLength(0);
  });

  it("records each attempt as its own call: the dropped one estimated, the retry under its own session", async () => {
    state.plan = ["anthropic-drop-mid"];
    await synth("anthropic");
    const rows = draftUsageRows();
    // One row per successful section, plus the dropped attempt.
    expect(rows).toHaveLength(groups.length + 1);
    const dropped = rows.filter((r) => r.agentStep === "docs-gen-aborted");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].inputTokens).toBeGreaterThan(0);
    const retry = rows.filter((r) => /-retry1$/.test(r.sessionId));
    expect(retry).toHaveLength(1);
    expect(retry[0].agentStep).toBe("docs-gen");
    expect(retry[0].inputTokens).toBe(1000);
    // The retry is not merged into the dropped attempt's session.
    expect(retry[0].sessionId.startsWith(dropped[0].sessionId)).toBe(true);
    expect(retry[0].sessionId).not.toBe(dropped[0].sessionId);
  });
});

describe("a section retry respects the run's stop switch and ceilings (#855)", () => {
  it("a cancel during the backoff wait stops the run at once, without asking again", async () => {
    const control = new GenerationControl("doc-1", "p");
    state.plan = ["anthropic-drop-mid"];
    sleeper.impl = (_ms, signal) => {
      control.stop("aborted");
      return new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    const run = withGenerationScope(control, () => synth("anthropic"));
    await expect(run).rejects.toBeInstanceOf(UnpublishableGenerationError);
    // The wait was given the run's signal, and the dropped prompt was never re-sent.
    expect(sleeper.calls[0].signal).toBe(control.signal);
    const first = state.sectionCalls[0];
    expect(state.sectionCalls.filter((c) => c === first)).toHaveLength(1);
  });

  it("the dropped attempt's spend counts toward the run's token ceiling, which stops the retry", async () => {
    // The sections and a retry together stay far under this ceiling; only the
    // dropped attempt's own reported usage (100k prompt tokens) reaches it.
    const control = new GenerationControl("doc-2", "p", {
      maxCostCents: null,
      maxTokens: 50_000,
    });
    state.plan = ["drop-mid-after-usage"];
    const run = withGenerationScope(control, () => synth("anthropic"));
    // The run ends: the drop error surfaces unchanged once the run has been
    // stopped (`isGenerationStop` reads any error after a stop as the stop), and
    // the run's stop error is the ceiling's.
    await expect(run).rejects.toThrow("anthropic stream failed (TypeError): terminated");
    expect(control.reason).toBe("budget");
    expect(control.stopError()).toBeInstanceOf(UnpublishableGenerationError);
    expect(control.stopError()?.message).toBe("Generation reached its cost ceiling");
    const first = state.sectionCalls[0];
    expect(state.sectionCalls.filter((c) => c === first)).toHaveLength(1);
    expect(sleeper.calls).toHaveLength(0);
    // Recorded as reported, under the section-draft step.
    const dropped = draftUsageRows().filter((r) => r.inputTokens === 100_000);
    expect(dropped).toHaveLength(1);
    expect(dropped[0].agentStep).toBe("docs-gen");
  });

  it("a stop that lands while the backoff wait resolves is not followed by another attempt", async () => {
    const control = new GenerationControl("doc-3", "p");
    state.plan = ["anthropic-drop-mid"];
    // The wait itself resolves (no abort listener), so only the per-attempt
    // stop check stands between the stop and a re-sent prompt.
    sleeper.impl = async () => {
      control.stop("aborted");
    };
    const run = withGenerationScope(control, () => synth("anthropic"));
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    // The run's own stop error, from the per-attempt stop check.
    expect(err).toBeInstanceOf(UnpublishableGenerationError);
    expect(err).toBe(control.stopError());
    const first = state.sectionCalls[0];
    expect(state.sectionCalls.filter((c) => c === first)).toHaveLength(1);
  });

  it("a call the run stopped mid-stream is recorded once, by the wrapper, and not noted twice", async () => {
    const control = new GenerationControl("doc-4", "p");
    const noteSpend = vi.spyOn(control, "noteSpend");
    state.plan = ["stop-then-drop"];
    state.stopRun = () => control.stop("aborted");
    const run = withGenerationScope(control, () => synth("anthropic", { scoped: true }));
    await expect(run).rejects.toThrow();
    const rows = draftUsageRows().filter((r) => r.inputTokens === 77_777);
    // Exactly one ledger row for the stopped call: the wrapper's aborted-call row.
    expect(rows).toHaveLength(1);
    expect(rows[0].agentStep).toBe("docs-gen-aborted");
    expect(draftUsageRows().filter((r) => r.sessionId === rows[0].sessionId)).toHaveLength(1);
    // The wrapper records a stopped call to the ledger only (#855), so the run's
    // tally is not given this call's spend a second time by the drop path.
    expect(noteSpend.mock.calls.filter(([e]) => e.inputTokens === 77_777)).toHaveLength(0);
  });
});

describe("#1209 — a run stops retrying drops once its sections keep dropping", () => {
  const exhaust = (): Step[] => Array<Step>(MID_STREAM_DROP_ATTEMPTS).fill("anthropic-drop-mid");

  it("after two sections used up their retries, the third is tried once and says why; provenance records it", async () => {
    expect(groups.length).toBeGreaterThanOrEqual(3);
    state.plan = [...exhaust(), ...exhaust(), "anthropic-drop-mid"];
    const result = await synth("anthropic");
    const f = failed(result);
    expect(f.map((w) => w.section)).toEqual([groups[0].label, groups[1].label, groups[2].label]);
    // Three tries each for the first two sections, ONE for the third.
    expect(state.sectionCalls).toHaveLength(groups.length + 2 * (MID_STREAM_DROP_ATTEMPTS - 1));
    expect(f[2].message).toBe(
      `Section "${groups[2].label}" could not be generated: the AI provider's connection dropped while it was writing this section (1 attempt; METIS stopped retrying after the connection dropped on earlier sections too). Regenerate the document to try this section again; the finished sections are reused.`,
    );
    expect(result.dropRetries).toEqual({
      reason: "repeated-connection-drops",
      limit: 2,
      exhaustedSections: 2,
    });
  });

  it("one exhausted section does not stop retrying, and records nothing", async () => {
    state.plan = [...exhaust(), "anthropic-drop-mid"];
    const result = await synth("anthropic");
    // The second section's drop was retried and succeeded.
    expect(failed(result)).toHaveLength(1);
    expect(state.sectionCalls).toHaveLength(groups.length + MID_STREAM_DROP_ATTEMPTS);
    expect(result.dropRetries).toBeUndefined();
  });

  it("the limit is configurable: 1 stops after the first exhausted section", async () => {
    vi.stubEnv("DOCS_GEN_DROP_RETRY_SECTION_LIMIT", "1");
    state.plan = [...exhaust(), "anthropic-drop-mid"];
    const result = await synth("anthropic");
    expect(failed(result)).toHaveLength(2);
    expect(state.sectionCalls).toHaveLength(groups.length + MID_STREAM_DROP_ATTEMPTS - 1);
    expect(result.dropRetries).toMatchObject({ limit: 1, exhaustedSections: 1 });
  });

  it("0 never stops retrying", async () => {
    vi.stubEnv("DOCS_GEN_DROP_RETRY_SECTION_LIMIT", "0");
    state.plan = [...exhaust(), ...exhaust(), "anthropic-drop-mid"];
    const result = await synth("anthropic");
    // The third section's drop is retried, and the retry succeeds.
    expect(failed(result)).toHaveLength(2);
    expect(state.sectionCalls).toHaveLength(groups.length + 2 * (MID_STREAM_DROP_ATTEMPTS - 1) + 1);
    expect(result.dropRetries).toBeUndefined();
  });

  it("each run has its own count: a later run retries again", async () => {
    state.plan = [...exhaust(), ...exhaust()];
    await synth("anthropic");
    state.sectionCalls = [];
    state.plan = ["anthropic-drop-mid"];
    const second = await synth("anthropic");
    expect(failed(second)).toEqual([]);
    expect(state.sectionCalls).toHaveLength(groups.length + 1);
  });
});
