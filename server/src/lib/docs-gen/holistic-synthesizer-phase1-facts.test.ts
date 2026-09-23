/**
 * #154 / #155 / #156 — Phase-1 facts: topic slices per section, every
 * language's mined rules reaching the Rules section directly, and truncated
 * replies being retried instead of cached.
 *
 * Deterministic: prisma and node:fs/promises are mocked; providers are stubs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { AIProvider, ChatChunk } from "../ai/types.js";

const readFileMock = vi.hoisted(() => vi.fn());
const upsertMock = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const findUniqueMock = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../prisma.js", () => ({
  prisma: {
    finding: { findMany: vi.fn().mockResolvedValue([]) },
    docsGenFactCache: {
      findUnique: findUniqueMock,
      update: vi.fn().mockResolvedValue({}),
      upsert: upsertMock,
    },
  },
}));

vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async (p: string) => path.resolve(p)),
  readFile: readFileMock,
  readdir: vi.fn().mockResolvedValue([]),
}));

import {
  buildRelevantFactsBlob,
  buildSectionFactsSources,
  extractModuleFacts,
  factSlicesFor,
  phase1RetryMaxTokens,
  sectionGroupsFor,
  selectRelevantFacts,
  summarizeFactsBudget,
  type DocType,
  type ModuleFacts,
  type ModuleGroup,
  type SectionGroup,
} from "./holistic-synthesizer.js";
import type { PersistedMinedRule } from "./fact-slices.js";

const DOC_TYPES: DocType[] = ["business-requirements", "architecture", "user-guide"];

function groupById(docType: DocType, id: string): SectionGroup {
  const g = sectionGroupsFor(docType).find((x) => x.id === id);
  if (!g) throw new Error(`no group ${id}`);
  return g;
}

const rulesGroup = () => groupById("business-requirements", "rules");
const integrationsGroup = () => groupById("business-requirements", "integrations-and-glossary");

function facts(name: string, text: string, over: Partial<ModuleFacts> = {}): ModuleFacts {
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 0,
    facts: text,
    formulas: [],
    topClasses: [],
    ...over,
  };
}

const PAYMENTS = `PURPOSE
Takes card payments.

RULES
- Amount must be positive

INTEGRATIONS
- Stripe charges API

NOTES
${Array.from({ length: 40 }, (_, k) => `- long operational aside ${k}`).join("\n")}`;

// ============================================================================
// #154 — each section reads only its declared slices
// ============================================================================

describe("#154 section groups declare the fact slices they read", () => {
  it.each(DOC_TYPES)("every %s group declares a non-empty slice list including summary", (dt) => {
    for (const g of sectionGroupsFor(dt)) {
      expect(g.factSlices, g.id).toBeDefined();
      expect(g.factSlices!.length, g.id).toBeGreaterThan(0);
      expect(g.factSlices, g.id).toContain("summary");
    }
  });

  it("only the Rules sections read the mined-rule inventory", () => {
    const withMined = DOC_TYPES.flatMap((dt) => sectionGroupsFor(dt))
      .filter((g) => g.minedRules)
      .map((g) => g.id);
    expect(withMined.sort()).toEqual(["rules", "rules-and-calcs"]);
  });

  it("an ad-hoc group reads the slices of its id, and an unknown id reads everything", () => {
    expect(factSlicesFor({ id: "rules", label: "r", instructions: "" })).toEqual([
      "summary",
      "rules",
    ]);
    expect(factSlicesFor({ id: "nope", label: "n", instructions: "" })).toContain("notes");
  });
});

describe("#154 buildRelevantFactsBlob sends only the section's slices", () => {
  it("the Rules blob carries RULES but not INTEGRATIONS or NOTES", () => {
    const blob = buildRelevantFactsBlob(
      [facts("pay", PAYMENTS)],
      rulesGroup(),
      "business-requirements",
    );
    expect(blob).toContain("### MODULE: pay");
    expect(blob).toContain("Takes card payments.");
    expect(blob).toContain("Amount must be positive");
    expect(blob).not.toContain("Stripe charges API");
    expect(blob).not.toContain("long operational aside");
  });

  it("the Integrations blob carries INTEGRATIONS but not RULES", () => {
    const blob = buildRelevantFactsBlob(
      [facts("pay", PAYMENTS)],
      integrationsGroup(),
      "business-requirements",
    );
    expect(blob).toContain("Stripe charges API");
    expect(blob).not.toContain("Amount must be positive");
  });

  it("a malformed (heading-less) reply still reaches every section via summary", () => {
    const text = "The model ignored the format: amounts over 10000 need approval.";
    for (const dt of DOC_TYPES) {
      for (const g of sectionGroupsFor(dt)) {
        expect(buildRelevantFactsBlob([facts("m", text)], g, dt), `${dt}/${g.id}`).toContain(
          "amounts over 10000 need approval",
        );
      }
    }
  });

  it("the citable facts sources carry exactly the text of the blob (lock-step)", () => {
    const all = [
      facts("pay", PAYMENTS),
      facts("ship", "PURPOSE\nShips.\n\nRULES\n- Weight under 30kg\n- No liquids"),
    ];
    const blob = buildRelevantFactsBlob(all, rulesGroup(), "business-requirements");
    const sources = buildSectionFactsSources(all, rulesGroup(), "business-requirements");
    expect(sources.map((s) => s.text).join("\n\n---\n\n")).toBe(blob);
    expect(sources.every((s) => !s.text.includes("Stripe charges API"))).toBe(true);
  });

  it("fits more modules at the same cap than whole blobs did", () => {
    const heavy = (i: number) =>
      facts(
        `m${i}`,
        `PURPOSE\nModule ${i}.\n\nRULES\n- rule ${i}\n\nINTEGRATIONS\n${Array.from({ length: 30 }, (_, k) => `- integration detail line ${k}`).join("\n")}`,
      );
    const all = Array.from({ length: 10 }, (_, i) => heavy(i));
    const cap = 2_000;
    const rules = selectRelevantFacts(all, rulesGroup(), "business-requirements", cap);
    expect(rules.included).toHaveLength(10);
    // The same facts sent whole (a group reading every slice) no longer fit.
    const whole = selectRelevantFacts(
      all,
      { id: "unknown-reads-all", label: "x", instructions: "" },
      "business-requirements",
      cap,
    );
    expect(whole.included.length).toBeLessThan(3);
  });

  it("ranks by the section's own slices, not by other topics", () => {
    const ruleHeavy = facts("rulesy", "PURPOSE\nx\n\nRULES\n- r\n- a\n- b\n- c\n- d");
    const integHeavy = facts(
      "integy",
      `PURPOSE\nx\n\nRULES\n- one\n\nINTEGRATIONS\n${Array.from({ length: 20 }, (_, i) => `- i${i}`).join("\n")}`,
    );
    const { included } = selectRelevantFacts(
      [integHeavy, ruleHeavy],
      rulesGroup(),
      "business-requirements",
    );
    expect(included[0].moduleName).toBe("rulesy");
  });
});

describe("#154 facts-truncated budget is measured on the section's slices", () => {
  const big = (i: number) =>
    facts(
      `m${i}`,
      `PURPOSE\nM${i}.\n\nRULES\n- rule ${i}\n\nNOTES\n${Array.from({ length: 200 }, (_, k) => `- aside ${k}`).join("\n")}`,
    );

  it("is not exceeded when the rules slices fit even though whole blobs would not", () => {
    const all = [big(1), big(2), big(3)];
    const budget = summarizeFactsBudget(all, rulesGroup(), "business-requirements", 1_000);
    expect(budget.exceeded).toBe(false);
    expect(budget.includedModules).toBe(3);
    // The reported chars are the sliced entries the section reads, not whole blobs.
    const blob = buildRelevantFactsBlob(all, rulesGroup(), "business-requirements", 1_000);
    expect(budget.includedChars).toBe(blob.length - 2 * "\n\n---\n\n".length);
  });

  it("still reports omitted modules when the section's own slices do not fit", () => {
    const all = [big(1), big(2), big(3)];
    const notes = groupById("architecture", "ops-and-stack");
    const budget = summarizeFactsBudget(all, notes, "architecture", 1_000);
    expect(budget.exceeded).toBe(true);
    expect(budget.omittedModules).toBeGreaterThan(0);
  });
});

// ============================================================================
// #155 — mined rules reach the Rules section directly, persisted, deduped
// ============================================================================

function offlineProvider(): AIProvider {
  return {
    key: "offline-stub",
    model: "mock",
    offline: true,
    chat: vi.fn(),
    stream: vi.fn(() => {
      throw new Error("no LLM may be called");
    }),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
  } as unknown as AIProvider;
}

/** An online stub whose Phase-1 stream replies are scripted per call. */
function scriptedProvider(
  replies: Array<{ text: string; finishReason?: string }>,
  model = "mock-local-model",
): AIProvider & { calls: Array<{ maxTokens?: number }> } {
  const calls: Array<{ maxTokens?: number }> = [];
  let n = 0;
  return {
    key: "scripted",
    model,
    offline: false,
    calls,
    chat: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue([model]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(_messages: unknown, opts: { maxTokens?: number }): AsyncGenerator<ChatChunk> {
      calls.push({ maxTokens: opts.maxTokens });
      const reply = replies[Math.min(n++, replies.length - 1)];
      yield { type: "delta", content: reply.text };
      yield {
        type: "usage",
        usage: { promptTokens: 100, completionTokens: 8192, cacheReadTokens: 0 },
      };
      yield { type: "done", ...(reply.finishReason ? { finishReason: reply.finishReason } : {}) };
    },
  } as unknown as AIProvider & { calls: Array<{ maxTokens?: number }> };
}

const TS_SOURCE = `export function charge(amount: number, currency: string) {
  if (amount <= 0) {
    throw new Error("Amount must be positive");
  }
  if (currency.length !== 3) {
    throw new Error("Currency must be a 3-letter ISO code");
  }
  return amount;
}
`;

function tsModule(): ModuleGroup {
  return {
    dir: "src/billing",
    syms: [
      {
        id: "t1",
        codeGraphId: "graph-a",
        qualifiedName: "billing.ts::charge",
        kind: "function",
        language: "ts",
        filePath: "src/billing/billing.ts",
        startLine: 1,
        endLine: 9,
      },
    ],
  };
}

describe("#155 a TypeScript module's guard clauses reach the Rules section input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
    readFileMock.mockResolvedValue(TS_SOURCE);
  });

  it("with zero LLM involvement, citable by file:line, in blob and sources alike", async () => {
    const provider = offlineProvider();
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.stream).not.toHaveBeenCalled();
    // The offline facts say nothing about rules; only the miner found them.
    expect(f!.facts).toContain("(none extracted in offline mode)");
    const tsRules = f!.minedRules!.filter((r) => r.language === "ts");
    expect(tsRules.length).toBeGreaterThan(0);

    const blob = buildRelevantFactsBlob([f!], rulesGroup(), "business-requirements");
    expect(blob).toContain("MINED_RULES");
    expect(blob).toMatch(/amount <= 0/);
    expect(blob).toMatch(/currency\.length !== 3/);
    expect(blob).toMatch(/\(src\/billing\/billing\.ts:2\)/);

    const [source] = buildSectionFactsSources([f!], rulesGroup(), "business-requirements");
    expect(source.text).toMatch(/\(src\/billing\/billing\.ts:2\)/);
  });

  it("does not send the mined inventory to a section that does not read rules", async () => {
    const f = await extractModuleFacts(tsModule(), offlineProvider(), false, "p1", "/clone");
    const blob = buildRelevantFactsBlob([f!], integrationsGroup(), "business-requirements");
    expect(blob).not.toContain("MINED_RULES");
  });

  it("drops an LLM rule bullet that restates a mined rule, keeping the citable one", () => {
    const mined: PersistedMinedRule[] = [
      {
        language: "ts",
        kind: "guard",
        expression: "if (amount <= 0)",
        summary: "guard",
        file: "src/billing/billing.ts",
        line: 2,
        context: null,
      },
    ];
    const m = facts(
      "billing",
      "PURPOSE\nBilling.\n\nRULES\n- Rejects when `if (amount <= 0)` holds\n- Refunds need a reason",
      { minedRules: mined },
    );
    const blob = buildRelevantFactsBlob([m], rulesGroup(), "business-requirements");
    expect(blob.match(/amount <= 0/g)).toHaveLength(1);
    expect(blob).toContain("(src/billing/billing.ts:2)");
    expect(blob).toContain("Refunds need a reason");
  });

  it("persists every language's rules and reads them back through the cache", async () => {
    const provider = scriptedProvider([
      { text: "PURPOSE\nBilling.\n\nRULES\n- r", finishReason: "stop" },
    ]);
    const first = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const written = upsertMock.mock.calls[0][0].create;
    const persisted = JSON.parse(written.minedRulesJson) as PersistedMinedRule[];
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.every((r) => r.language === "ts")).toBe(true);
    expect(persisted[0]).toMatchObject({ file: "src/billing/billing.ts" });

    // Second run: the row comes back from the cache. The rules returned must be
    // the ones READ from the row, not re-derived — prove it by making the row
    // differ from what mining would produce.
    const fromRow: PersistedMinedRule[] = [{ ...persisted[0], summary: "READ FROM CACHE ROW" }];
    findUniqueMock.mockResolvedValue({
      ...written,
      id: "row1",
      createdAt: new Date(),
      minedRulesJson: JSON.stringify(fromRow),
    });
    const second = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.calls).toHaveLength(1); // cache hit — no second LLM call
    expect(second!.minedRules).toEqual(fromRow);
    expect(first!.minedRules).toEqual(persisted);
  });

  it("re-mines on a cache hit whose row is a legacy Java-only inventory", async () => {
    const provider = scriptedProvider([{ text: "PURPOSE\nx", finishReason: "stop" }]);
    findUniqueMock.mockResolvedValue({
      id: "row1",
      createdAt: new Date(),
      classCount: 0,
      methodCount: 1,
      facts: "PURPOSE\nx",
      formulasJson: "[]",
      topClassesJson: "[]",
      minedRulesJson: JSON.stringify([{ kind: "throw", expression: "x", filePath: "A.java" }]),
    });
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(f!.minedRules!.some((r) => r.language === "ts")).toBe(true);
  });
});

// ============================================================================
// #156 — truncated Phase-1 replies are retried once and never cached
// ============================================================================

describe("#156 phase1RetryMaxTokens", () => {
  it("doubles the cap for a model with no known ceiling", () => {
    expect(phase1RetryMaxTokens(8192, "gemma3:12b")).toBe(16384);
  });

  it("clamps the retry to the model's known output ceiling", () => {
    expect(phase1RetryMaxTokens(6000, "anthropic.claude-3-5-haiku-20241022-v1:0")).toBe(8192);
  });

  it("returns null when the cap is already at the ceiling (nothing larger to ask for)", () => {
    expect(phase1RetryMaxTokens(8192, "anthropic.claude-3-5-haiku-20241022-v1:0")).toBeNull();
  });
});

describe("#156 extractModuleFacts on a truncated reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
    readFileMock.mockResolvedValue(TS_SOURCE);
  });

  it("retries once with a larger cap and caches the complete retry", async () => {
    const provider = scriptedProvider([
      { text: "PURPOSE\nBilling.\n\nRULES\n- cut off mid", finishReason: "length" },
      { text: "PURPOSE\nBilling.\n\nRULES\n- complete rule", finishReason: "stop" },
    ]);
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1].maxTokens).toBe(provider.calls[0].maxTokens! * 2);
    expect(f!.facts).toContain("complete rule");
    expect(f!.factsTruncated).toBeUndefined();
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][0].create.facts).toContain("complete rule");
  });

  it("does not cache facts that are still truncated after the retry, and flags them", async () => {
    const provider = scriptedProvider([
      { text: "PURPOSE\nBilling.\n\nRULES\n- cut off", finishReason: "length" },
    ]);
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.calls).toHaveLength(2);
    expect(f!.factsTruncated).toBe(true);
    // The partial facts are still used for this run...
    expect(f!.facts).toContain("cut off");
    // ...but never cached as if complete.
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("treats the gateway's max-tokens placeholder as truncation and strips it", async () => {
    const provider = scriptedProvider([
      {
        text: "PURPOSE\nBilling.\n[No response text was returned by the model (stopReason=max_tokens)]",
      },
    ]);
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(f!.factsTruncated).toBe(true);
    expect(f!.facts).not.toContain("No response text");
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("does not retry when the cap is already the model's ceiling, and does not cache", async () => {
    const provider = scriptedProvider(
      [{ text: "PURPOSE\nx\n\nRULES\n- cut", finishReason: "max_tokens" }],
      "anthropic.claude-3-5-haiku-20241022-v1:0",
    );
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.calls).toHaveLength(1);
    expect(f!.factsTruncated).toBe(true);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("keeps the first truncated reply when the larger-cap retry itself fails", async () => {
    let call = 0;
    const provider = {
      ...scriptedProvider([]),
      async *stream(): AsyncGenerator<ChatChunk> {
        call += 1;
        if (call > 1) throw new Error("model crashed");
        yield { type: "delta", content: "PURPOSE\nBilling.\n\nRULES\n- partial" };
        yield { type: "done", finishReason: "length" };
      },
    } as unknown as AIProvider;
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(call).toBe(2);
    expect(f!.facts).toContain("partial");
    expect(f!.factsTruncated).toBe(true);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("falls back to a stub and does not cache when the call fails outright", async () => {
    const provider = {
      ...scriptedProvider([]),
      async *stream(): AsyncGenerator<ChatChunk> {
        throw new Error("400 bad request");
      },
    } as unknown as AIProvider;
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(f!.facts).toContain("(extraction failed)");
    expect(f!.factsTruncated).toBeUndefined();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("retries the stream setup once on a gateway 503", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const provider = {
        ...scriptedProvider([]),
        async *stream(): AsyncGenerator<ChatChunk> {
          call += 1;
          if (call === 1) throw new Error("gateway returned 503");
          yield { type: "delta", content: "PURPOSE\nok" };
          yield { type: "done", finishReason: "stop" };
        },
      } as unknown as AIProvider;
      const pending = extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
      await vi.advanceTimersByTimeAsync(5_000);
      const f = await pending;
      expect(call).toBe(2);
      expect(f!.facts).toBe("PURPOSE\nok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry or flag a complete reply", async () => {
    const provider = scriptedProvider([{ text: "PURPOSE\nx", finishReason: "stop" }]);
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.calls).toHaveLength(1);
    expect(f!.factsTruncated).toBeUndefined();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});
