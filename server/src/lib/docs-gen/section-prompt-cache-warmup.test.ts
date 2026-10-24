/**
 * #1329 — the shared prefix of a section's sibling batches, as each provider's
 * cache can read it.
 *
 *   - DeepSeek caches automatically, but writes a cache unit only when a call
 *     ENDS. A section's first wave of parallel batches therefore read none of
 *     their shared prefix (about 1.3k tokens each on the 2026-10-23 run, 25.6k
 *     for a batch sent after one had finished). One short warm-up call that
 *     holds exactly the shared prefix is sent first, and awaited.
 *   - Native Anthropic caches per block, and the batches' shared user lead (the
 *     retrieved excerpts) sat inside one user text block whose only breakpoint
 *     was the system prompt's. The lead now ends in a breakpoint of its own.
 *
 * Built through the real prompt-assembly path (`synthesizeFinalDocument`, its
 * batching and its grounding merge), with a fake model that records every
 * call. No network, no database, no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scoreFaithfulnessMock = vi.hoisted(() => vi.fn());

vi.mock("./grounding/citation-validator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./grounding/citation-validator.js")>();
  return { ...actual, scoreFaithfulness: scoreFaithfulnessMock };
});

const logInfoMock = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logger.js")>();
  const quiet = () => {};
  const child = { info: logInfoMock, warn: quiet, debug: quiet, error: quiet, verbose: quiet };
  return { ...actual, createChildLogger: () => ({ ...child, child: () => child }) };
});

const recordUsageMock = vi.hoisted(() => vi.fn());
vi.mock("../finops/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../finops/index.js")>();
  return { ...actual, recordUsage: recordUsageMock };
});

import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../ai/types.js";
import { PREFIX_WARM_UP_MAX_TOKENS } from "../ai/prompt-cache-warmup.js";
import { UnpublishableGenerationError } from "./generation-checkpoint.js";
import { GenerationControl } from "./generation-control.js";
import { withGenerationScope } from "./generation-scope.js";
import { buildGroundingContext, type GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type GenerationStepHook,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";

const pad = (n: number, seed: string): string =>
  `${seed} ${"the request is validated against the configured policy and rejected otherwise ".repeat(Math.ceil(n / 80) + 1)}`.slice(
    0,
    n,
  );

function mod(name: string): ModuleFacts {
  const bullets = (kind: string, n: number) =>
    Array.from({ length: n }, (_, i) => `- ${pad(108, `${kind} ${i} of ${name}:`)}`).join("\n");
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 4,
    facts: [
      "PURPOSE",
      `${name} handles one business capability.`,
      "RULES",
      bullets("rule", 20),
      "WORKFLOWS",
      bullets("step", 12),
      "ENTITIES",
      bullets("entity", 4),
    ].join("\n"),
    formulas: [],
    topClasses: [],
  };
}

interface Call {
  index: number;
  section: string;
  system: string;
  user: string;
  opts: ChatOptions;
}

/** Every stream call, plus the order calls started and finished in. */
interface Recording {
  calls: Call[];
  events: string[];
}

interface FakeProvider {
  key: string;
  model: string;
  servesRouterModel?: (m: string) => boolean;
  /** The adapter points at DeepSeek's own API (`AIProvider.deepSeekPrefixCache`). */
  deepSeekPrefixCache?: boolean;
  /** The warm-up call (1 output token) fails with a 400. */
  failWarmUp?: boolean;
  /** Called when the warm-up call starts; what it throws, the stream throws. */
  onWarmUp?: () => void;
}

function recordingModel(rec: Recording, provider: FakeProvider): AIProvider {
  const { failWarmUp, onWarmUp, ...identity } = provider;
  return {
    ...identity,
    offline: false,
    async *stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatChunk> {
      const text = (m: ChatMessage | undefined) => String(m?.content ?? "");
      const user = text(messages[messages.length - 1]);
      const section = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      const index = rec.calls.length;
      rec.calls.push({ index, section, system: text(messages[0]), user, opts });
      rec.events.push(`start:${index}`);
      if (opts.maxTokens === PREFIX_WARM_UP_MAX_TOKENS) {
        try {
          onWarmUp?.();
        } finally {
          if (onWarmUp) rec.events.push(`end:${index}`);
        }
      }
      if (failWarmUp && opts.maxTokens === PREFIX_WARM_UP_MAX_TOKENS) {
        rec.events.push(`end:${index}`);
        throw Object.assign(new Error("max_tokens too small"), { status: 400 });
      }
      try {
        // Let the other calls of a wave start before this one ends.
        await new Promise((r) => setTimeout(r, 5));
        rec.events.push(`first:${index}`);
        yield { type: "delta", content: `## ${section}\n\n### Topic\n\nWritten.` };
        yield {
          type: "usage",
          usage: { promptTokens: 1_000, completionTokens: 10, totalTokens: 1_010 },
        };
        yield { type: "done", finishReason: "stop" };
      } finally {
        rec.events.push(`end:${index}`);
      }
    },
    async chat(): Promise<never> {
      throw new Error("chat not used");
    },
    async embed(): Promise<never> {
      throw new Error("embed not used");
    },
    async models(): Promise<string[]> {
      return [];
    },
    async ping(): Promise<boolean> {
      return true;
    },
  } as unknown as AIProvider;
}

/** Retrieved repository excerpts, as a run with source on disk is given. */
const EXCERPT_CHARS = 2_000;
const EXCERPTS = 6;
function repositoryGrounding(): GroundingContext {
  return buildGroundingContext({
    ragChunks: Array.from({ length: EXCERPTS }, (_, i) => ({
      documentId: `doc-${i}`,
      chunkId: `chunk-${i}`,
      filename: `connector:repo:fixture:internal/file${i}.go`,
      evidenceClass: "repository-source" as const,
      text: `// excerpt ${i}\n${pad(EXCERPT_CHARS - 20, `func handle${i}() error`)}`,
    })),
  });
}

async function generate(
  provider: FakeProvider,
  /** `null`: no retrieved grounding at all. */
  grounding: GroundingContext | null = repositoryGrounding(),
): Promise<Recording> {
  const rec: Recording = { calls: [], events: [] };
  await generateInto(rec, provider, undefined, grounding);
  return rec;
}

/** {@link generate}, recording into `rec` so a run that throws still leaves its calls. */
async function generateInto(
  rec: Recording,
  provider: FakeProvider,
  beforeStep?: GenerationStepHook,
  grounding: GroundingContext | null = repositoryGrounding(),
): Promise<void> {
  const model = recordingModel(rec, provider);
  const kind = provider.key === "bedrock-gateway" ? "bedrock" : "anthropic";
  const tuning = docsGenTuning(kind, provider.model);
  const router: Phase2Router = {
    primary: { kind, provider: model, supportsCaching: true, factsCharCap: 150_000, tuning },
    hybrid: null,
  };
  await synthesizeFinalDocument(
    Array.from({ length: 6 }, (_, i) => mod(`p${i}`)),
    { name: "Fixture", totalFiles: 60, totalSymbols: 900, language: "go" } as never,
    "business-requirements",
    "BRD",
    router,
    "p1",
    grounding ?? undefined,
    undefined,
    undefined,
    undefined,
    beforeStep ? { beforeStep } : undefined,
  );
}

const RULES = sectionGroupsFor("business-requirements").find((g) => g.id === "rules")!;
const OVERVIEW = sectionGroupsFor("business-requirements").find((g) => g.id === "overview")!;

const isWarmUp = (c: Call) => c.opts.maxTokens === PREFIX_WARM_UP_MAX_TOKENS;
const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};
const stream = (c: Call) => `${c.system}\u0000${c.user}`;

beforeEach(() => {
  recordUsageMock.mockReset();
  scoreFaithfulnessMock.mockReset();
  scoreFaithfulnessMock.mockResolvedValue({
    section: "x",
    totalClaims: 1,
    supportedClaims: 1,
    faithfulness: 1,
    verified: true,
    unsupportedClaims: [],
    supportedAttributions: [],
  });
  // Small enough a cap that the six modules are written in several batches.
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096");
  // DeepSeek reasons by default, and its reasoning allowance would let one
  // batch hold the whole section.
  vi.stubEnv("DOCS_GEN_REASONING_ALLOWANCE_TOKENS", "0");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "1000000000");
  vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "1000000000");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DeepSeek: a warm-up writes the batches' shared prefix before they fan out (#1329)", () => {
  // An adapter pointed at DeepSeek's own API (PR #1516 review: by host, not model id).
  const DEEPSEEK = { key: "anthropic", model: "deepseek-flash", deepSeekPrefixCache: true };

  it("sends one capped call holding exactly the shared prefix, and every batch shares all of it", async () => {
    const { calls } = await generate(DEEPSEEK);
    const rules = calls.filter((c) => c.section === RULES.label);
    const warmUps = rules.filter(isWarmUp);
    const batches = rules.filter((c) => !isWarmUp(c));
    expect(batches.length).toBeGreaterThan(1);
    expect(warmUps).toHaveLength(1);
    const [warmUp] = warmUps;
    // The warm-up holds the retrieved excerpts and stops before any batch's own facts.
    for (const source of repositoryGrounding().sources) expect(warmUp.user).toContain(source.text);
    expect(warmUp.user).not.toContain("=== EXTRACTED MODULE FACTS ===");
    // Its own telemetry bucket, not the section drafts'.
    expect(warmUp.opts.callType).toBe("warmup");
    for (const batch of batches) expect(batch.opts.callType).toBe("synthesis");
    // Its whole prompt is a prefix of every batch's: the length each batch reads back.
    for (const batch of batches) {
      expect(batch.system).toBe(warmUp.system);
      expect(batch.user.startsWith(warmUp.user)).toBe(true);
      expect(commonPrefix(stream(warmUp), stream(batch))).toBe(stream(warmUp).length);
    }
  });

  // PR #1516 review — a tokenizer merges a run of newlines, so the warm-up
  // must not end on one the parts continue: it ends on the fence's `===`, and
  // every part goes on with the blank line and its own facts.
  it("ends the warm-up on the closing fence, with the newline on every part's side", async () => {
    const { calls } = await generate(DEEPSEEK);
    const rules = calls.filter((c) => c.section === RULES.label);
    const warmUp = rules.find(isWarmUp)!;
    // The exact last bytes: the fence, and no trailing whitespace.
    expect(warmUp.user.endsWith("\n\n=== END GROUNDING SOURCES ===")).toBe(true);
    expect(warmUp.user).toBe(warmUp.user.trimEnd());
    for (const batch of rules.filter((c) => !isWarmUp(c))) {
      expect(batch.user.slice(warmUp.user.length, warmUp.user.length + 32)).toBe(
        "\n\n=== EXTRACTED MODULE FACTS ===",
      );
    }
  });

  it("counts the warm-up among the section's calls in its log", async () => {
    logInfoMock.mockClear();
    const { calls } = await generate(DEEPSEEK);
    const rules = calls.filter((c) => c.section === RULES.label);
    const line = logInfoMock.mock.calls.find(
      (c) =>
        c[0] === "Batched section synthesized" &&
        (c[1] as { group?: string } | undefined)?.group === RULES.id,
    );
    expect(line, "no 'Batched section synthesized' line for rules").toBeDefined();
    expect((line![1] as { calls: number }).calls).toBe(rules.length);
  });

  it("rethrows a run stop raised by the warm-up's pre-call check and sends no part", async () => {
    const stop = new UnpublishableGenerationError("aborted", "Generation was cancelled");
    const beforeStep: GenerationStepHook = async (step) => {
      if (step.kind === "batch" && step.section === RULES.label) throw stop;
    };
    const rec: Recording = { calls: [], events: [] };
    await expect(generateInto(rec, DEEPSEEK, beforeStep)).rejects.toBe(stop);
    expect(rec.calls.filter((c) => c.section === RULES.label)).toEqual([]);
  });

  it("rethrows a run stop raised while the warm-up streams, never the soft warning path", async () => {
    const control = new GenerationControl("doc-warm-up-stop", "p1");
    const aborted = new Error("warm-up stream aborted");
    const rec: Recording = { calls: [], events: [] };
    const run = withGenerationScope(control, () =>
      generateInto(rec, {
        ...DEEPSEEK,
        onWarmUp: () => {
          control.stop("aborted");
          throw aborted;
        },
      }),
    );
    // The warm-up's own error surfaces (a soft catch would go on and fail at
    // the first part's stop check with the run's stop error instead).
    await expect(run).rejects.toBe(aborted);
    const rules = rec.calls.filter((c) => c.section === RULES.label);
    expect(rules).toHaveLength(1);
    expect(isWarmUp(rules[0])).toBe(true);
  });

  it("sends no warm-up for a DeepSeek model served by another host", async () => {
    for (const host of [
      { key: "bedrock-gateway", model: "us.deepseek.r1-v1:0" },
      { key: "anthropic", model: "deepseek-flash" },
    ]) {
      const { calls } = await generate(host);
      expect(calls.filter((c) => c.section === RULES.label).length).toBeGreaterThan(1);
      expect(calls.filter(isWarmUp)).toHaveLength(0);
    }
  });

  it("sends the batches only once the warm-up has finished", async () => {
    const { calls, events } = await generate(DEEPSEEK);
    const rules = calls.filter((c) => c.section === RULES.label);
    const warmUp = rules.find(isWarmUp)!;
    const warmUpEnd = events.indexOf(`end:${warmUp.index}`);
    expect(warmUpEnd).toBeGreaterThan(-1);
    for (const batch of rules.filter((c) => !isWarmUp(c))) {
      expect(events.indexOf(`start:${batch.index}`)).toBeGreaterThan(warmUpEnd);
    }
  });

  it("records the warm-up in the ledger under its own session", async () => {
    await generate(DEEPSEEK);
    const sessions = recordUsageMock.mock.calls.map((c) => String(c[0].sessionId));
    const warmUps = sessions.filter((s) => s.includes(`-${RULES.id}-warmup-`));
    expect(warmUps).toHaveLength(1);
    expect(warmUps[0].startsWith("docs-synth-p1-business-requirements-")).toBe(true);
  });

  it("sends the batches anyway when the warm-up fails, and writes the section", async () => {
    const { calls } = await generate({ ...DEEPSEEK, failWarmUp: true });
    const rules = calls.filter((c) => c.section === RULES.label);
    expect(rules.filter(isWarmUp)).toHaveLength(1);
    expect(rules.filter((c) => !isWarmUp(c)).length).toBeGreaterThan(1);
    const sessions = recordUsageMock.mock.calls.map((c) => String(c[0].sessionId));
    expect(sessions.some((s) => s.includes("-warmup-"))).toBe(false);
    expect(sessions.filter((s) => s.includes(`-${RULES.id}-draft-`)).length).toBeGreaterThan(1);
  });

  it("sends no warm-up for a section written in one call", async () => {
    const { calls } = await generate(DEEPSEEK);
    const overview = calls.filter((c) => c.section === OVERVIEW.label);
    expect(overview).toHaveLength(1);
    expect(overview.filter(isWarmUp)).toHaveLength(0);
  });

  it("sends no warm-up for a model with an explicit-breakpoint cache", async () => {
    const { calls } = await generate({ key: "anthropic", model: "claude-sonnet-4-6" });
    expect(calls.filter(isWarmUp)).toHaveLength(0);
  });

  it("sends no warm-up when the shared lead is too short to be worth one", async () => {
    // No retrieved grounding: the lead is a few lines of document context.
    const { calls } = await generate(DEEPSEEK, null);
    expect(calls.filter((c) => c.section === RULES.label).length).toBeGreaterThan(1);
    expect(calls.filter(isWarmUp)).toHaveLength(0);
  });
});

describe("Anthropic: the batches' shared user lead ends in a cache breakpoint (#1329)", () => {
  it("asks every batch of a section to cache through the lead, which holds every excerpt", async () => {
    const { calls } = await generate({ key: "anthropic", model: "claude-sonnet-4-6" });
    const rules = calls.filter((c) => c.section === RULES.label);
    expect(rules.length).toBeGreaterThan(1);
    const leads = rules.map((c) => c.opts.promptCaching?.userPrefix ?? "");
    for (const [i, batch] of rules.entries()) {
      expect(batch.opts.promptCaching).toMatchObject({ system: true, messages: false });
      expect(leads[i].length).toBeGreaterThan(EXCERPTS * (EXCERPT_CHARS - 100));
      expect(batch.user.startsWith(leads[i])).toBe(true);
      expect(leads[i]).not.toContain("=== EXTRACTED MODULE FACTS ===");
      expect(leads[i]).toBe(leads[0]);
    }
  });

  // Panel finding on this PR: the first-batch wait (#208) counts the lead now.
  // Haiku 4.5 caches nothing under 4,096 tokens; its system prompt alone is
  // under that, the system prompt and the excerpts are over it.
  it("holds the other batches until the first reply begins when only the lead clears the floor", async () => {
    const HAIKU = { key: "anthropic", model: "claude-haiku-4-5" };
    const firstBatchHeld = (rec: Recording): boolean => {
      const [first, ...rest] = rec.calls.filter((c) => c.section === RULES.label);
      expect(rest.length).toBeGreaterThan(0);
      const begun = rec.events.indexOf(`first:${first.index}`);
      return rest.every((c) => rec.events.indexOf(`start:${c.index}`) > begun);
    };
    const withLead = await generate(HAIKU);
    const rules = withLead.calls.filter((c) => c.section === RULES.label);
    expect(Math.ceil(rules[0].system.length / 4)).toBeLessThan(4_096);
    const lead = rules[0].opts.promptCaching?.userPrefix ?? "";
    expect(Math.ceil((rules[0].system.length + lead.length) / 4)).toBeGreaterThanOrEqual(4_096);
    expect(firstBatchHeld(withLead)).toBe(true);
    // Control: with no retrieved grounding the lead is short, and the batches fan out at once.
    expect(firstBatchHeld(await generate(HAIKU, null))).toBe(false);
  });

  it("writes no lead breakpoint for a section written in one call", async () => {
    const { calls } = await generate({ key: "anthropic", model: "claude-sonnet-4-6" });
    const overview = calls.filter((c) => c.section === OVERVIEW.label);
    expect(overview).toHaveLength(1);
    expect(overview[0].opts.promptCaching?.userPrefix).toBeUndefined();
  });

  it("writes no lead breakpoint behind the Bedrock gateway or on DeepSeek", async () => {
    for (const provider of [
      { key: "bedrock-gateway", model: "us.anthropic.claude-sonnet-4-6" },
      { key: "anthropic", model: "deepseek-flash" },
    ]) {
      const { calls } = await generate(provider);
      expect(calls.some((c) => c.opts.promptCaching?.userPrefix !== undefined)).toBe(false);
    }
  });
});
