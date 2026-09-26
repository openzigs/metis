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
const readdirMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
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
  readdir: readdirMock,
}));

import {
  buildRelevantFactsBlob,
  buildSectionFactsSources,
  extractModuleFacts,
  factSlicesFor,
  PHASE1_SPLIT_MARKER,
  planSectionBatches,
  sectionGroupsFor,
  selectRelevantFacts,
  summarizeFactsBudget,
  type DocType,
  type ModuleFacts,
  type ModuleGroup,
  type SectionGroup,
} from "./holistic-synthesizer.js";
import type { PersistedMinedRule } from "./fact-slices.js";
import { MAX_PHASE1_SPLIT_DEPTH } from "./phase1-chunking.js";
import { RunUsage, withRunUsage } from "./run-cost.js";

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
        usage: {
          promptTokens: 100,
          completionTokens: 8192,
          cacheReadTokens: 0,
          cacheWriteTokens: 40,
        },
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

  it("labels each mined rule in the Phase-1 prompt with file:line, not a bare line number", async () => {
    const prompts: string[] = [];
    const provider = {
      ...scriptedProvider([{ text: "PURPOSE\nx", finishReason: "stop" }]),
      async *stream(messages: Array<{ content: unknown }>): AsyncGenerator<ChatChunk> {
        prompts.push(String(messages[messages.length - 1].content));
        yield { type: "delta", content: "PURPOSE\nx" };
        yield { type: "done", finishReason: "stop" };
      },
    } as unknown as AIProvider;
    await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(prompts[0]).toMatch(/^- src\/billing\/billing\.ts:2: /m);
    expect(prompts[0]).not.toMatch(/^- L\d+:/m);
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

  it("keeps an LLM bullet whose mined rule was cut from the inventory by its char cap", () => {
    // 60 mined rules overflow MINED_RULES_ENTRY_CHAR_CAP, so the tail is not
    // rendered. A bullet restating a rule past the cut must survive — otherwise
    // the rule is in neither the inventory nor the bullets (PR #163 review).
    const mined: PersistedMinedRule[] = Array.from({ length: 60 }, (_, i) => ({
      language: "ts",
      kind: "guard",
      expression: `if (value > LIMIT_${i}_VALUE) throw new RangeError("limit ${i}")`,
      summary: `rejects values above limit ${i}`,
      file: "src/limits/limits.ts",
      line: i + 1,
      context: null,
    }));
    const m = facts(
      "limits",
      "PURPOSE\nLimits.\n\nRULES\n" +
        '- Enforces `if (value > LIMIT_0_VALUE) throw new RangeError("limit 0")`\n' +
        '- Enforces `if (value > LIMIT_59_VALUE) throw new RangeError("limit 59")`',
      { minedRules: mined },
    );
    const blob = buildRelevantFactsBlob([m], rulesGroup(), "business-requirements");
    expect(blob).toMatch(/more mined rule\(s\) omitted/);
    expect(blob).not.toContain("(src/limits/limits.ts:60)");
    // Rendered rule 0: deduped to exactly one mention (the citable one).
    expect(blob.match(/LIMIT_0_VALUE/g)).toHaveLength(1);
    // Omitted rule 59: its LLM bullet is the only mention left, so it stays.
    expect(blob.match(/LIMIT_59_VALUE/g)).toHaveLength(1);
  });

  it("persists every mined rule with its chunk, and a cache hit re-mines instead of reading rules back", async () => {
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
    expect(first!.minedRules).toEqual(persisted);

    // Second run: the chunk's reply comes from the cache. Mining is
    // deterministic and runs on every call, so the rules are this run's — a
    // row that disagrees (or is a legacy Java-only shape) cannot leak in.
    findUniqueMock.mockResolvedValue({
      ...written,
      id: "row1",
      createdAt: new Date(),
      minedRulesJson: JSON.stringify([{ kind: "throw", expression: "x", filePath: "A.java" }]),
    });
    const second = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.calls).toHaveLength(1); // cache hit — no second LLM call
    expect(second!.facts).toBe("PURPOSE\nBilling.\n\nRULES\n- r");
    expect(second!.minedRules).toEqual(persisted);
  });
});

// ============================================================================
// Phase 1 reads every function: truncation splits, it never doubles the cap
// ============================================================================

/** `n` TypeScript functions of ~`lines` lines each, one per line range. */
function bigTsSource(n: number, lines: number): string {
  return Array.from({ length: n }, (_, i) =>
    [
      `export function rule${i}(amount: number) {`,
      ...Array.from({ length: lines - 2 }, (_, k) =>
        k % 10 === 0
          ? `  if (amount > ${i * 1000 + k}) { throw new Error("limit ${i}.${k} exceeded"); }`
          : `  const step${k} = amount * ${k};`,
      ),
      "}",
    ].join("\n"),
  ).join("\n");
}

function bigTsModule(n: number, lines: number): ModuleGroup {
  return {
    dir: "src/limits",
    syms: Array.from({ length: n }, (_, i) => ({
      id: `f${i}`,
      codeGraphId: "graph-a",
      qualifiedName: `limits.ts::rule${i}`,
      kind: "function",
      language: "ts",
      filePath: "src/limits/limits.ts",
      startLine: i * lines + 1,
      endLine: (i + 1) * lines,
    })),
  };
}

/** A provider that is cut off whenever it is given more than `maxFns` functions. */
function sizeLimitedProvider(maxFns: number): AIProvider & {
  prompts: string[];
  calls: Array<{ maxTokens?: number }>;
} {
  const prompts: string[] = [];
  const calls: Array<{ maxTokens?: number }> = [];
  return {
    key: "scripted",
    model: "mock-local-model",
    offline: false,
    prompts,
    calls,
    chat: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue(["mock"]),
    ping: vi.fn().mockResolvedValue(true),
    async *stream(
      messages: Array<{ content: unknown }>,
      opts: { maxTokens?: number },
    ): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      prompts.push(user);
      calls.push({ maxTokens: opts.maxTokens });
      const fns = [...user.matchAll(/^\/\/ limits\.ts::(rule\d+)/gm)].map((m) => m[1]);
      const cut = fns.length > maxFns;
      yield {
        type: "delta",
        content: `PURPOSE\nLimits.\n\nRULES\n${fns.map((f) => `- ${f} enforces its limit`).join("\n")}`,
      };
      yield { type: "done", finishReason: cut ? "length" : "stop" };
    },
  } as unknown as AIProvider & { prompts: string[]; calls: Array<{ maxTokens?: number }> };
}

describe("Phase 1 reads a module far bigger than the old budgets, in chunks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
  });

  it("puts every function in some call and merges the chunk facts into one module", async () => {
    // 120 functions x 40 lines: >3x the old 80-method cap and ~10x the 60K-char budget.
    readFileMock.mockResolvedValue(bigTsSource(120, 40));
    const provider = sizeLimitedProvider(1_000);
    const f = await extractModuleFacts(bigTsModule(120, 40), provider, false, "p1", "/clone");
    expect(provider.calls.length).toBeGreaterThan(1);
    const read = provider.prompts.flatMap((p) =>
      [...p.matchAll(/^\/\/ limits\.ts::(rule\d+)$/gm)].map((m) => m[1]),
    );
    expect(read).toHaveLength(120);
    expect(new Set(read).size).toBe(120);
    // One merged RULES section carrying every chunk's bullets, once each.
    expect(f!.facts.match(/^RULES$/gm)).toHaveLength(1);
    for (let i = 0; i < 120; i++) expect(f!.facts).toContain(`- rule${i} enforces its limit`);
    expect(f!.phase1Coverage).toMatchObject({
      functionsIncluded: 120,
      functionsTotal: 120,
      chunks: provider.calls.length,
      truncatedChunks: 0,
      failedChunks: 0,
    });
    // Every function's rules are mined — none depends on a snippet budget —
    // each once, at its file line, attributed to its function.
    for (let i = 0; i < 120; i++) {
      const own = f!.minedRules!.filter((r) => r.context === `limits.ts::rule${i}`);
      expect(own.length, `rule${i}`).toBeGreaterThan(0);
      expect(own.every((r) => r.line > i * 40 && r.line <= (i + 1) * 40)).toBe(true);
    }
    const keys = f!.minedRules!.map((r) => `${r.line}|${r.kind}|${r.expression}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Each chunk is cached on its own.
    expect(upsertMock).toHaveBeenCalledTimes(provider.calls.length);
  });

  it("splits a cut-off chunk and re-extracts each half, never asking for a bigger cap", async () => {
    readFileMock.mockResolvedValue(bigTsSource(24, 40));
    const provider = sizeLimitedProvider(2);
    let chunksDone = 0;
    const f = await extractModuleFacts(
      bigTsModule(24, 40),
      provider,
      false,
      "p1",
      "/clone",
      undefined,
      undefined,
      true,
      { onChunkDone: () => (chunksDone += 1) },
    );
    // Progress counts PLANNED chunks: a split chunk reports once, when both halves are done.
    expect(chunksDone).toBe(f!.phase1Coverage!.chunks);
    expect(provider.calls.length).toBeGreaterThan(chunksDone);
    const caps = new Set(provider.calls.map((c) => c.maxTokens));
    expect(caps.size).toBe(1);
    // Every function is in exactly one COMPLETE (≤2-function) reply.
    const complete = provider.prompts
      .map((p) => [...p.matchAll(/^\/\/ limits\.ts::(rule\d+)$/gm)].map((m) => m[1]))
      .filter((fns) => fns.length <= 2)
      .flat();
    expect(complete.sort()).toEqual(Array.from({ length: 24 }, (_, i) => `rule${i}`).sort());
    expect(f!.factsTruncated).toBeUndefined();
    // Cut-off replies are never cached as facts: their chunk gets a split
    // marker, and each complete half is cached as itself.
    const cached = upsertMock.mock.calls.map((c) => c[0].create.facts as string);
    expect(cached.filter((t) => t === PHASE1_SPLIT_MARKER).length).toBeGreaterThan(0);
    const factsRows = cached.filter((t) => t !== PHASE1_SPLIT_MARKER);
    expect(factsRows).toHaveLength(
      provider.calls.length - cached.filter((t) => t === PHASE1_SPLIT_MARKER).length,
    );
  });

  it("a re-run follows the remembered splits straight to the cached halves (no calls)", async () => {
    readFileMock.mockResolvedValue(bigTsSource(24, 40));
    const store = new Map<string, { facts: string }>();
    upsertMock.mockImplementation(
      async (args: {
        where: { projectId_cacheKey: { cacheKey: string } };
        create: { facts: string };
      }) => {
        store.set(args.where.projectId_cacheKey.cacheKey, { facts: args.create.facts });
        return {};
      },
    );
    findUniqueMock.mockImplementation(
      async (args: { where: { projectId_cacheKey: { cacheKey: string } } }) => {
        const row = store.get(args.where.projectId_cacheKey.cacheKey);
        return row ? { id: "r", createdAt: new Date(), model: "m", ...row } : null;
      },
    );
    const first = sizeLimitedProvider(2);
    const a = await extractModuleFacts(bigTsModule(24, 40), first, false, "p1", "/clone");
    const second = sizeLimitedProvider(2);
    const b = await extractModuleFacts(bigTsModule(24, 40), second, false, "p1", "/clone");
    expect(first.calls.length).toBeGreaterThan(0);
    expect(second.calls).toHaveLength(0);
    expect(b!.facts).toBe(a!.facts);
    expect(b!.phase1Coverage!.cacheHits).toBeGreaterThan(0);
  });

  it("bounds the splitting: a model that is always cut off costs a bounded number of calls", async () => {
    readFileMock.mockResolvedValue(bigTsSource(24, 40));
    const provider = sizeLimitedProvider(-1); // cut off on every call
    const f = await extractModuleFacts(bigTsModule(24, 40), provider, false, "p1", "/clone");
    const planned = f!.phase1Coverage!.chunks;
    expect(provider.calls.length).toBeLessThanOrEqual(
      planned * (2 ** (MAX_PHASE1_SPLIT_DEPTH + 1) - 1),
    );
    expect(f!.factsTruncated).toBe(true);
    expect(f!.phase1Coverage!.truncatedChunks).toBeGreaterThan(0);
    expect(f!.phase1Coverage!.functionsExtracted).toBe(0);
    expect(f!.phase1Coverage!.functionsInTruncatedChunks).toBe(24);
    // Nothing that was cut off is cached as facts.
    for (const c of upsertMock.mock.calls) expect(c[0].create.facts).toBe(PHASE1_SPLIT_MARKER);
  });

  it("keeps the other chunks' facts when one chunk's call fails, and caches only those", async () => {
    readFileMock.mockResolvedValue(bigTsSource(60, 40));
    let n = 0;
    const base = sizeLimitedProvider(1_000);
    const provider = {
      ...base,
      async *stream(messages: Array<{ content: unknown }>, opts: { maxTokens?: number }) {
        n += 1;
        if (n === 1) throw new Error("400 bad request");
        yield* base.stream(messages as never, opts as never);
      },
    } as unknown as AIProvider;
    const f = await extractModuleFacts(bigTsModule(60, 40), provider, false, "p1", "/clone");
    expect(n).toBeGreaterThan(1);
    expect(f!.facts).not.toContain("(extraction failed)");
    expect(f!.phase1Coverage!.failedChunks).toBe(1);
    expect(upsertMock).toHaveBeenCalledTimes(n - 1);
    // A failed chunk's functions are planned, never counted as extracted.
    const cov = f!.phase1Coverage!;
    expect(cov.functionsInFailedChunks).toBeGreaterThan(0);
    expect(cov.functionsExtracted + cov.functionsInFailedChunks).toBe(cov.functionsIncluded);
    expect(cov.functionsExtracted).toBeLessThan(cov.functionsIncluded);
  });
});

// ============================================================================
// #156 — a cut-off reply is never cached as if complete
// ============================================================================

describe(".sql files are mined in full (no 500-rule cap)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
  });

  it("700 CHECK constraints → 700 mined rules, persisted, and every one reaches a Rules batch", async () => {
    const sql = Array.from(
      { length: 700 },
      (_, i) => `ALTER TABLE payments ADD CONSTRAINT chk_${i} CHECK (amount > ${i});`,
    ).join("\n");
    readdirMock.mockResolvedValueOnce([
      { name: "schema.sql", isFile: () => true, isDirectory: () => false },
    ]);
    readFileMock.mockImplementation(async (p: string) => (p.endsWith(".sql") ? sql : TS_SOURCE));
    const provider = scriptedProvider([{ text: "PURPOSE\nx", finishReason: "stop" }]);
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    const sqlRules = f!.minedRules!.filter((r) => r.language === "sql");
    expect(sqlRules).toHaveLength(700);
    // Persisted: across the chunk rows, every SQL rule once.
    const persisted = upsertMock.mock.calls.flatMap(
      (c) => JSON.parse(c[0].create.minedRulesJson) as PersistedMinedRule[],
    );
    expect(persisted.filter((r) => r.language === "sql")).toHaveLength(700);
    // Reaches Rules: every rule cited in exactly one planned batch prompt.
    const plan = planSectionBatches([f!], rulesGroup(), 150_000, 16_384);
    const prompts = plan.batches.map((b) => b.map((m) => m.entry).join("\n")).join("\n");
    const file = path.join("src/billing", "schema.sql");
    for (let line = 1; line <= 700; line++) {
      expect(prompts.split(`(${file}:${line})`).length - 1, `line ${line}`).toBe(1);
    }
  });
});

describe("a unit too large for one call even at one line", () => {
  it("is counted and logged as oversized, and still sent", async () => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
    // A minified one-line file of ~200K chars.
    const line = `export const T = [${Array.from({ length: 20_000 }, (_, i) => i).join(",")}];`;
    readFileMock.mockResolvedValue(line);
    const mod: ModuleGroup = {
      dir: "src/min",
      syms: [
        {
          id: "m",
          qualifiedName: "min.js",
          kind: "module",
          language: "js",
          filePath: "src/min/min.js",
          startLine: 1,
          endLine: 1,
        },
      ],
    };
    const prompts: string[] = [];
    const provider = {
      ...scriptedProvider([]),
      async *stream(messages: Array<{ content: unknown }>): AsyncGenerator<ChatChunk> {
        prompts.push(String(messages[messages.length - 1].content));
        yield { type: "delta", content: "PURPOSE\nx" };
        yield { type: "done", finishReason: "stop" };
      },
    } as unknown as AIProvider;
    const f = await extractModuleFacts(mod, provider, false, "p1", "/clone");
    expect(f!.phase1Coverage!.oversizedUnits).toBe(1);
    expect(prompts.join("")).toContain("19999");
  });
});

describe("SAS workflow steps are never truncated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
  });

  const STEPS = 300;
  const sas = [
    "%macro etl;",
    ...Array.from({ length: STEPS }, (_, i) => [
      `data work.out${i};`,
      `  set work.in${i};`,
      `  if amount > ${i};`,
      "run;",
    ]).flat(),
    "%mend;",
  ].join("\n");
  const sasModule = (): ModuleGroup => ({
    dir: "sas/etl",
    syms: [
      {
        id: "m1",
        qualifiedName: "etl.sas::etl",
        kind: "function",
        language: "sas",
        filePath: "sas/etl/etl.sas",
        startLine: 1,
        endLine: STEPS * 4 + 2,
      },
    ],
  });

  it("appends every one of 300 steps (and its lineage) to the module's facts", async () => {
    readFileMock.mockResolvedValue(sas);
    const f = await extractModuleFacts(sasModule(), offlineProvider(), false, "p1", "/clone");
    expect(f!.facts).not.toContain("truncated for prompt budget");
    for (let i = 0; i < STEPS; i++) {
      expect(f!.facts, `step ${i}`).toContain(`work.out${i}`);
    }
  });

  it.each(["8192", "65536"])(
    "gives every step to exactly one Phase-1 call (facts cap %s)",
    async (cap) => {
      // At a large cap one chunk holds far more than the old 6,000-char pipeline.
      vi.stubEnv("DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS", cap);
      readFileMock.mockResolvedValue(sas);
      const prompts: string[] = [];
      const provider = {
        ...scriptedProvider([]),
        async *stream(messages: Array<{ content: unknown }>): AsyncGenerator<ChatChunk> {
          prompts.push(String(messages[messages.length - 1].content));
          yield { type: "delta", content: "PURPOSE\nx" };
          yield { type: "done", finishReason: "stop" };
        },
      } as unknown as AIProvider;
      await extractModuleFacts(sasModule(), provider, false, "p1", "/clone");
      const pipelines = prompts.map((p) =>
        p.slice(
          p.indexOf("=== DETERMINISTICALLY-MINED SAS STEP PIPELINE"),
          p.indexOf("=== END SAS STEP PIPELINE"),
        ),
      );
      expect(pipelines.join("")).not.toContain("truncated for prompt budget");
      for (let i = 0; i < STEPS; i++) {
        const needle = `**DATA work.out${i}**`;
        expect(
          pipelines.filter((p) => p.includes(needle)),
          needle,
        ).toHaveLength(1);
      }
      vi.unstubAllEnvs();
    },
  );
});

describe("#156 extractModuleFacts on a truncated reply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
    readFileMock.mockResolvedValue(TS_SOURCE);
  });

  it("keeps a small chunk's cut-off reply for this run, flags it, and does not cache it", async () => {
    // One 9-line function cannot explain a cut-off (the model is running away),
    // so it is not split: one call, partial facts, never cached.
    const provider = scriptedProvider([
      { text: "PURPOSE\nBilling.\n\nRULES\n- cut off", finishReason: "length" },
    ]);
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.calls).toHaveLength(1);
    expect(f!.factsTruncated).toBe(true);
    expect(f!.facts).toContain("cut off");
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

  it("never returns a stale split marker as facts: an unsplittable chunk goes to the model", async () => {
    findUniqueMock.mockResolvedValue({
      id: "row",
      createdAt: new Date(),
      model: "m",
      facts: PHASE1_SPLIT_MARKER,
    });
    const provider = scriptedProvider([{ text: "PURPOSE\nfresh facts", finishReason: "stop" }]);
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.calls).toHaveLength(1);
    expect(f!.facts).toBe("PURPOSE\nfresh facts");
    expect(f!.facts).not.toContain("[[phase1");
    expect(f!.phase1Coverage!.cacheHits).toBe(0);
  });

  it("does not retry or flag a complete reply, and caches it once", async () => {
    const provider = scriptedProvider([{ text: "PURPOSE\nx", finishReason: "stop" }]);
    const f = await extractModuleFacts(tsModule(), provider, false, "p1", "/clone");
    expect(provider.calls).toHaveLength(1);
    expect(f!.factsTruncated).toBeUndefined();
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});

describe("#178 a Phase-1 call's recorded usage counts toward the run's cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueMock.mockResolvedValue(null);
    upsertMock.mockResolvedValue({});
    readFileMock.mockResolvedValue(TS_SOURCE);
  });

  it("adds the call's token counts to the run it ran in", async () => {
    const provider = scriptedProvider([{ text: "PURPOSE\nCharges a card.", finishReason: "stop" }]);
    const usage = new RunUsage();
    await withRunUsage(usage, () =>
      extractModuleFacts(tsModule(), provider, false, "p1", "/clone"),
    );
    expect(provider.calls).toHaveLength(1);
    expect(usage.lines()).toEqual([
      {
        provider: "scripted",
        model: "mock-local-model",
        calls: 1,
        inputTokens: 100,
        outputTokens: 8192,
        cacheReadTokens: 0,
        cacheWriteTokens: 40,
      },
    ]);
  });
});
