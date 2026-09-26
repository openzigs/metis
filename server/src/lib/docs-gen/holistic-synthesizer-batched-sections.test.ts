/**
 * #157 — batched synthesis of the enumerative section groups (Business Rules,
 * Key Workflows, Calculations, Data Model), through `synthesizeFinalDocument`.
 *
 * The fixture is onyourleft-SIZED (143 modules; per-module topic slices sized
 * like the real gemma3:12b facts: ~32 rule bullets of ~110 chars each) but
 * entirely synthetic, so no project text is committed. The fake model writes a
 * reply proportional to the facts it is given (1.25 output chars per input char,
 * 3.9 chars per token, as measured on the real cut-off sections) and reports
 * `finish_reason: "length"` when that reply would pass the output cap — i.e. it
 * fails exactly the way run 9 did when a section is given too much to write.
 *
 * `scoreFaithfulness` is mocked so per-batch grounding can be observed without
 * a live judge. No network, no database, no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scoreFaithfulnessMock = vi.hoisted(() => vi.fn());

vi.mock("./grounding/citation-validator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./grounding/citation-validator.js")>();
  return { ...actual, scoreFaithfulness: scoreFaithfulnessMock };
});

vi.mock("../finops/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../finops/index.js")>();
  return { ...actual, recordUsage: vi.fn() };
});

import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../ai/types.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import type { FaithfulnessResult } from "./grounding/citation-validator.js";
import {
  batchNoteFor,
  buildRelevantFactsBlob,
  docsGenTuning,
  planSectionBatches,
  rankRelevantFacts,
  sectionGroupsFor,
  selectRelevantFacts,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2ProviderBundle,
  type Phase2Router,
  type SectionGroup,
} from "./holistic-synthesizer.js";
import type { PersistedMinedRule } from "./fact-slices.js";
import { RunUsage, withRunUsage } from "./run-cost.js";

// ── Fixture ───────────────────────────────────────────────────────────────

/** `seed` padded with filler prose to exactly `n` characters. */
const pad = (n: number, seed: string): string =>
  `${seed} ${"the request is validated against the configured policy and rejected otherwise ".repeat(Math.ceil(n / 80) + 1)}`.slice(
    0,
    n,
  );

/** One module shaped like a real Phase-1 facts blob, sized by bullet counts. */
function mod(
  name: string,
  counts: { rules: number; workflows?: number; formulas?: number; entities?: number },
  extra: Partial<ModuleFacts> = {},
): ModuleFacts {
  const bullets = (kind: string, n: number) =>
    Array.from({ length: n }, (_, i) => `- ${pad(108, `${kind} ${i} of ${name}:`)}`).join("\n");
  const facts = [
    "PURPOSE",
    `${name} handles one business capability.`,
    "RULES",
    bullets("rule", counts.rules),
    "WORKFLOWS",
    bullets("step", counts.workflows ?? 0) || "(none)",
    "FORMULAS",
    bullets("formula", counts.formulas ?? 0) || "(none)",
    "ENTITIES",
    bullets("entity", counts.entities ?? 0) || "(none)",
    "NOTES",
    pad(3_000, `notes for ${name}`),
  ].join("\n");
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 4,
    facts,
    formulas: [],
    topClasses: [],
    ...extra,
  };
}

/** 143 modules with onyourleft's per-module spread (rules bullets 12–52, mean ~32). */
function onyourleftSized(): ModuleFacts[] {
  return Array.from({ length: 143 }, (_, i) =>
    mod(`m${String(i).padStart(3, "0")}`, {
      rules: 12 + ((i * 7) % 41),
      workflows: 10 + ((i * 5) % 30),
      formulas: 3 + ((i * 3) % 15),
      entities: 2 + (i % 8),
    }),
  );
}

// ── Fake model ────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 3.9;
const OUTPUT_PER_INPUT_CHAR = 1.25;

interface Call {
  group: string;
  modules: string[];
  user: string;
  maxTokens: number;
}

interface FakeOptions {
  /** Appended to every rule line, so a scorer can tell providers apart. */
  marker?: string;
  /** Force a cut-off for a call (in addition to the proportional cap check). */
  cutOff?: (call: Call) => boolean;
  /** Throw for a call. */
  fail?: (call: Call) => boolean;
  /** Return an empty reply (a zero-token stream that still ends "stop"). */
  empty?: (call: Call) => boolean;
  /** #178 — milliseconds a call takes, so calls can finish out of order. */
  delayMs?: (call: Call) => number;
  /** #178 — report token usage for every call. */
  usage?: { promptTokens: number; completionTokens: number; cacheReadTokens?: number };
}

/** #178 — what a fake model observed about concurrency. */
interface Concurrency {
  /** Calls in the order they FINISHED. */
  finished: Call[];
  /** Most calls in flight at once. */
  peak: number;
}

function fakeModel(
  options: FakeOptions = {},
  key = "anthropic",
): AIProvider & { calls: Call[] } & Concurrency {
  const calls: Call[] = [];
  let inFlight = 0;
  async function* reply(call: Call): AsyncGenerator<ChatChunk> {
    const { group, modules, maxTokens } = call;
    const factsText = call.user.slice(
      call.user.indexOf("=== EXTRACTED MODULE FACTS ==="),
      call.user.indexOf("=== END MODULE FACTS ==="),
    );
    if (options.fail?.(call)) throw new Error("upstream exploded with a secret stack trace");
    if (options.empty?.(call)) {
      yield { type: "done", finishReason: "stop" };
      return;
    }
    // One rule per module under a shared topic, padded to a reply proportional
    // to the facts read — the shape and scale of a real catalog reply.
    const perModule = modules.length
      ? Math.floor((factsText.length * OUTPUT_PER_INPUT_CHAR) / modules.length)
      : 0;
    const body = modules
      .map(
        (m, i) =>
          `### Topic ${i % 3}\n\n1. **Rule from ${m}**${options.marker ?? ""}\n   - **Condition**: ${pad(Math.max(perModule - 60, 10), m)}`,
      )
      .join("\n\n");
    let text = `## ${group}\n\n${body || "Nothing documented."}`;
    const capChars = Math.floor(maxTokens * CHARS_PER_TOKEN);
    const cut = text.length > capChars || options.cutOff?.(call) === true;
    if (cut) text = text.slice(0, Math.min(text.length, capChars, 400));
    yield { type: "delta", content: text };
    if (options.usage) yield { type: "usage", usage: options.usage };
    yield { type: "done", finishReason: cut ? "length" : "stop" };
  }
  const p = {
    key,
    model: "fake-section-model",
    offline: false,
    calls,
    finished: [] as Call[],
    peak: 0,
    async *stream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      const group = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      const factsText = user.slice(
        user.indexOf("=== EXTRACTED MODULE FACTS ==="),
        user.indexOf("=== END MODULE FACTS ==="),
      );
      const modules = [...factsText.matchAll(/^### MODULE: (\S+)/gm)].map((m) => m[1]);
      const maxTokens = (opts as { maxTokens?: number } | undefined)?.maxTokens ?? 0;
      const call: Call = { group, modules, user, maxTokens };
      calls.push(call);
      inFlight += 1;
      p.peak = Math.max(p.peak, inFlight);
      try {
        const ms = options.delayMs?.(call) ?? 0;
        if (ms > 0) await new Promise((r) => setTimeout(r, ms));
        yield* reply(call);
      } finally {
        inFlight -= 1;
        p.finished.push(call);
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
  };
  return p as unknown as AIProvider & { calls: Call[] } & Concurrency;
}

function routerFor(provider: AIProvider): Phase2Router {
  const tuning = docsGenTuning("anthropic", provider.model);
  const bundle: Phase2ProviderBundle = {
    kind: "anthropic",
    provider,
    supportsCaching: false,
    factsCharCap: tuning.factsCharCap,
    tuning,
  };
  return { primary: bundle };
}

const META = {
  name: "Fixture",
  totalFiles: 143,
  totalSymbols: 5_000,
  language: "typescript",
} as never;
const BATCHED = sectionGroupsFor("business-requirements").filter((g) => g.batched);
const RULES = BATCHED.find((g) => g.id === "rules")!;

async function run(
  facts: ModuleFacts[],
  provider: AIProvider,
  grounding?: GroundingContext,
): ReturnType<typeof synthesizeFinalDocument> {
  return synthesizeFinalDocument(
    facts,
    META,
    "business-requirements",
    "BRD",
    routerFor(provider),
    "p1",
    grounding,
  );
}

/** The markdown of one H2 section of an assembled document. */
function sectionOf(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const next = markdown.indexOf("\n## ", start + 3);
  return markdown.slice(start, next < 0 ? undefined : next);
}

const callsFor = (p: { calls: Call[] }, group: SectionGroup) =>
  p.calls.filter((c) => c.group === group.label);

beforeEach(() => {
  scoreFaithfulnessMock.mockReset();
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "16384");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── Which groups batch ────────────────────────────────────────────────────

describe("the enumerative groups opt into batching", () => {
  it("batches exactly Rules, Workflows, Calculations and Data Model", () => {
    expect(BATCHED.map((g) => g.id)).toEqual(["rules", "workflows", "formulas", "data-model"]);
    for (const docType of ["architecture", "user-guide"] as const) {
      expect(sectionGroupsFor(docType).some((g) => g.batched)).toBe(false);
    }
  });
});

// ── The onyourleft-sized run ─────────────────────────────────────────────

describe("an onyourleft-sized project (143 modules, 16,384-token cap — run 9's setting)", () => {
  it("reads EVERY relevant module in exactly one batch, with no facts-omitted catalog", async () => {
    const facts = onyourleftSized();
    const provider = fakeModel();
    await run(facts, provider);
    for (const group of BATCHED) {
      const calls = callsFor(provider, group);
      expect(calls.length, group.id).toBeGreaterThan(1);
      const read = calls.flatMap((c) => c.modules);
      expect(new Set(read).size, group.id).toBe(read.length);
      expect([...read].sort(), group.id).toEqual(facts.map((f) => f.moduleName).sort());
      for (const c of calls) expect(c.user).not.toContain("ADDITIONAL MODULES");
      for (const c of calls) expect(c.maxTokens).toBe(16_384);
    }
  });

  it("keeps every batch under the output cap — no section-truncated warning for these groups", async () => {
    const provider = fakeModel();
    const result = await run(onyourleftSized(), provider);
    const labels = new Set(BATCHED.map((g) => g.label));
    expect(
      result.warnings.filter((w) => w.kind === "section-truncated" && labels.has(w.section!)),
    ).toEqual([]);
    // Without batching, the same model is cut off on this fixture — it is big
    // enough to reproduce run 9's failure: one call's 150K-char facts blob
    // would need a reply far over the cap.
    const single = buildRelevantFactsBlob(
      onyourleftSized(),
      RULES,
      "business-requirements",
      150_000,
    );
    expect(single.length * OUTPUT_PER_INPUT_CHAR).toBeGreaterThan(16_384 * CHARS_PER_TOKEN);
  });

  it("merges each batched section into ONE H2 carrying every module's rules", async () => {
    const facts = onyourleftSized();
    const result = await run(facts, fakeModel());
    const rules = result.markdown.slice(
      result.markdown.indexOf("## Business Rules & Policies"),
      result.markdown.indexOf("## Key Workflows"),
    );
    expect(result.markdown.match(/^## Business Rules & Policies$/gm)).toHaveLength(1);
    for (const f of facts) expect(rules).toContain(`Rule from ${f.moduleName}**`);
    expect([...rules.matchAll(/^### (.+)$/gm)].map((m) => m[1])).toEqual([
      "Topic 0",
      "Topic 1",
      "Topic 2",
    ]);
  });

  it("lists every batch's modules as citable facts sources in the manifest", async () => {
    const facts = onyourleftSized();
    const result = await run(facts, fakeModel());
    const rules = result.sections.find((s) => s.sectionLabel === RULES.label)!;
    expect(rules.factsSourceIds).toHaveLength(143);
    expect(new Set(rules.factsSourceIds).size).toBe(143);
  });
});

// ── Planning ──────────────────────────────────────────────────────────────

describe("planSectionBatches", () => {
  it("follows the shared relevance ranking and skips modules with nothing on the topic", () => {
    const facts = [mod("a", { rules: 3 }), mod("empty", { rules: 0 }), mod("b", { rules: 20 })];
    const plan = planSectionBatches(facts, RULES, 150_000, 16_384);
    expect(plan.modules.map((m) => m.item.moduleName)).toEqual(["b", "a"]);
    expect(rankRelevantFacts(facts, RULES).map((f) => f.moduleName)).toEqual(["b", "a", "empty"]);
    expect(plan.skipped).toEqual(["empty"]);
  });

  it("sizes batches by estimated OUTPUT: more batches at a smaller cap over the same facts", () => {
    const facts = onyourleftSized();
    const at16k = planSectionBatches(facts, RULES, 150_000, 16_384);
    const at8k = planSectionBatches(facts, RULES, 150_000, 8_192);
    expect(at8k.batches.length).toBeGreaterThan(at16k.batches.length);
    for (const b of at16k.batches) {
      expect(b.reduce((n, m) => n + m.outputChars, 0)).toBeLessThanOrEqual(at16k.outputBudget);
    }
  });

  it("pages a module's mined rules across parts instead of capping them — none dropped, none twice", () => {
    const rule = (i: number): PersistedMinedRule => ({
      language: "ts",
      kind: "guard",
      expression: `amount > ${i}`,
      summary: `amount must exceed ${i}`,
      file: `src/x${i % 3}.ts`,
      line: i + 1,
      context: null,
    });
    const huge = mod(
      "huge",
      { rules: 5 },
      { minedRules: Array.from({ length: 400 }, (_, i) => rule(i)) },
    );
    const plan = planSectionBatches([huge, ...pairs(3)], RULES, 150_000, 16_384);
    const parts = plan.modules.filter((m) => m.item.moduleName === "huge");
    expect(parts.length).toBeGreaterThan(1);
    // Every part is labelled with the module and its part number, and fits half a batch.
    parts.forEach((p, i) => {
      expect(p.entry).toContain(`### MODULE: huge (part ${i + 1} of ${parts.length})`);
      expect(p.outputChars).toBeLessThanOrEqual(plan.outputBudget);
    });
    // Across the planned BATCH PROMPTS (what each call reads), every rule once, cited file:line.
    const prompts = plan.batches.map((b) => b.map((m) => m.entry).join("\n\n---\n\n")).join("\n");
    for (let i = 0; i < 400; i++) {
      const cite = `(src/x${i % 3}.ts:${i + 1})`;
      expect(prompts.split(cite).length - 1, cite).toBe(1);
    }
    expect(prompts).not.toContain("omitted to fit the budget");
    // No batch is over its budget.
    for (const b of plan.batches) {
      if (b.length > 1)
        expect(b.reduce((n, m) => n + m.outputChars, 0)).toBeLessThanOrEqual(plan.outputBudget);
    }
  });

  it("sends every one of 400 mined rules to exactly one Rules call of a real run", async () => {
    const huge = mod(
      "huge",
      { rules: 5 },
      {
        minedRules: Array.from({ length: 400 }, (_, i) => ({
          language: "kt" as const,
          kind: "precondition",
          expression: `require(x > ${i})`,
          summary: `x must exceed ${i}`,
          file: "app/Rules.kt",
          line: i + 1,
          context: null,
        })),
      },
    );
    const provider = fakeModel();
    const result = await run([huge, ...pairs(3)], provider);
    expect(result.warnings.filter((w) => w.section === RULES.label)).toEqual([]);
    const users = callsFor(provider, RULES)
      .map((c) => c.user)
      .join("\n");
    for (let i = 1; i <= 400; i++) {
      expect(users.split(`(app/Rules.kt:${i})`).length - 1, `rule ${i}`).toBe(1);
    }
  });

  it("renders a module that fits one batch as one entry, with its whole inventory", () => {
    const small = mod(
      "small",
      { rules: 3 },
      {
        minedRules: Array.from({ length: 80 }, (_, i) => ({
          language: "ts" as const,
          kind: "guard",
          expression: `v > ${i}`,
          summary: `v above ${i} — a threshold the account balance must stay under`,
          file: "src/s.ts",
          line: i + 1,
          context: null,
        })),
      },
    );
    const [m, ...rest] = planSectionBatches([small], RULES, 150_000, 16_384).modules;
    expect(rest).toEqual([]);
    expect(m.part).toBeUndefined();
    expect(m.entry.startsWith("### MODULE: small\n")).toBe(true);
    // Past the old 4,000-char cap (~25 rules): every rule, no "omitted" line.
    expect(m.entry).toContain("(src/s.ts:80)");
    expect(m.entry).not.toContain("omitted to fit the budget");
  });

  it("keeps the single-call selection unchanged for a group that does not batch", () => {
    const facts = onyourleftSized();
    const capabilities = sectionGroupsFor("business-requirements").find(
      (g) => g.id === "capabilities",
    )!;
    const { included, omitted } = selectRelevantFacts(
      facts,
      capabilities,
      "business-requirements",
      150_000,
    );
    expect(omitted.length).toBeGreaterThan(0);
    expect(included.length + omitted.length).toBe(143);
  });
});

// PR #169 review: the skip test ignored a module's EXTRACTED formulas, and the
// formulas block is built per batch — so on onyourleft 268 extracted formulas
// in skipped modules reached no Calculations batch at all.
describe("Calculations reads every module's extracted formulas", () => {
  const CALCS = BATCHED.find((g) => g.id === "formulas")!;
  const formula = (name: string, i: number) => ({
    kind: "arithmetic" as const,
    expression: `${name}_total_${i} = price * qty + ${i}`,
    description: "",
    name: null,
    resolvedValue: null,
    filePath: `src/${name}/x.ts`,
  });
  const withFormulas = (f: ModuleFacts, n: number): ModuleFacts =>
    ({ ...f, formulas: Array.from({ length: n }, (_, i) => formula(f.moduleName, i)) }) as never;
  const formulasOf = (user: string) =>
    user.slice(user.indexOf("=== FORMULAS/CONSTANTS"), user.indexOf("=== END FORMULAS ==="));

  it("does not skip a module whose only formula content is its extracted formulas", () => {
    const facts = [mod("bare", { rules: 3 }), withFormulas(mod("calc", { rules: 3 }), 2)];
    const plan = planSectionBatches(facts, CALCS, 150_000, 16_384);
    // Precondition: with no formula facts and no extracted formula, a module IS skipped.
    expect(plan.skipped).toEqual(["bare"]);
    expect(plan.modules.map((m) => m.item.moduleName)).toEqual(["calc"]);
  });

  it("keeps the rules section's skip rule unchanged — extracted formulas are not a rules topic", () => {
    const facts = [withFormulas(mod("calc", { rules: 0 }), 2)];
    expect(planSectionBatches(facts, RULES, 150_000, 16_384).skipped).toEqual(["calc"]);
  });

  it("never puts more extracted formulas in one batch than its formulas block renders", async () => {
    // 3 × 60 formulas: any two together pass the 80-entry block, so an
    // uncapped plan (one batch — the facts are tiny) would cut 100 of them.
    const facts = ["f0", "f1", "f2"].map((n) =>
      withFormulas(mod(n, { rules: 1, formulas: 1 }), 60),
    );
    const plan = planSectionBatches(facts, CALCS, 150_000, 16_384);
    expect(plan.batches.map((b) => b.length)).toEqual([1, 1, 1]);
    const provider = fakeModel();
    await run(facts, provider);
    const blocks = callsFor(provider, CALCS).map((c) => formulasOf(c.user));
    for (const f of facts) {
      for (let i = 0; i < 60; i++) {
        expect(
          blocks.some((b) => b.includes(`${f.moduleName}_total_${i} =`)),
          `${f.moduleName}_total_${i}`,
        ).toBe(true);
      }
    }
  });

  it("#172 pages one module's 300 formulas across labelled parts: each in exactly one batch", () => {
    const big = withFormulas(mod("ledger", { rules: 2, formulas: 2 }), 300);
    const plan = planSectionBatches([big, ...pairs(2)], CALCS, 150_000, 16_384);
    const parts = plan.modules.filter((m) => m.item.moduleName === "ledger");
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p, i) =>
      expect(p.entry).toContain(`### MODULE: ledger (part ${i + 1} of ${parts.length})`),
    );
    const assigned = plan.batches.flatMap((b) =>
      b
        .filter((m) => m.item.moduleName === "ledger")
        .flatMap((m) => (m.formulas ?? []).map((f) => f.expression)),
    );
    expect(assigned).toHaveLength(300);
    expect(new Set(assigned).size).toBe(300);
    for (const b of plan.batches) {
      expect(b.reduce((n, m) => n + (m.listItems ?? 0), 0)).toBeLessThanOrEqual(80);
    }
  });

  it("#172 pages a module whose formulas alone overflow the 80-entry block (issue's 99-formula case)", () => {
    // 99 formulas: small enough in output to fit one batch, but more than one
    // batch's formulas block holds — so it is paged, not cut to 80.
    const m99 = withFormulas(mod("route", { rules: 1, formulas: 1 }), 99);
    const plan = planSectionBatches([m99], CALCS, 150_000, 16_384);
    expect(plan.modules.length).toBeGreaterThan(1);
    const assigned = plan.modules.flatMap((m) => (m.formulas ?? []).map((f) => f.expression));
    expect(new Set(assigned).size).toBe(99);
    expect(assigned).toHaveLength(99);
    for (const b of plan.batches) {
      expect(b.reduce((n, m) => n + (m.listItems ?? 0), 0)).toBeLessThanOrEqual(80);
    }
  });

  it("#172 a real Calculations run gives every one of 300 formulas to exactly one call", async () => {
    const big = withFormulas(mod("ledger", { rules: 2, formulas: 2 }), 300);
    const provider = fakeModel();
    const result = await run([big, ...pairs(2)], provider);
    expect(result.warnings.filter((w) => w.section === CALCS.label)).toEqual([]);
    const blocks = callsFor(provider, CALCS).map((c) => formulasOf(c.user));
    expect(blocks.length).toBeGreaterThan(1);
    for (let i = 0; i < 300; i++) {
      const needle = `ledger_total_${i} =`;
      expect(
        blocks.filter((b) => b.includes(needle)),
        needle,
      ).toHaveLength(1);
    }
  });
});

describe("DOCS_GEN_BATCHED_SECTIONS — the operator's kill-switch", () => {
  beforeEach(() => vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096"));

  it.each(["0", "false", "off", "NO"])("=%s writes every batched group in ONE call", async (v) => {
    vi.stubEnv("DOCS_GEN_BATCHED_SECTIONS", v);
    const provider = fakeModel();
    await run(pairs(6), provider);
    for (const group of BATCHED) expect(callsFor(provider, group), group.id).toHaveLength(1);
  });

  it.each(["1", "true", ""])("=%s (or unset) keeps batching on", async (v) => {
    vi.stubEnv("DOCS_GEN_BATCHED_SECTIONS", v);
    const provider = fakeModel();
    await run(pairs(6), provider);
    expect(callsFor(provider, RULES)).toHaveLength(3);
  });
});

describe("batchNoteFor", () => {
  it("lets only the lead batch write the introduction", () => {
    expect(batchNoteFor(RULES, true, 5, 50)).not.toContain("Do NOT write an introduction");
    const rest = batchNoteFor(RULES, false, 5, 50);
    expect(rest).toContain("Do NOT write an introduction");
    expect(rest).toContain("5 of the 50 modules");
  });
});

// ── Adaptive re-split ────────────────────────────────────────────────────

/** Modules sized so every planned rules batch at a 4,096-token cap holds exactly two. */
function pairs(n: number): ModuleFacts[] {
  return Array.from({ length: n }, (_, i) => mod(`p${i}`, { rules: 20 }));
}

describe("a batch cut off at the cap is split and regenerated (bounded, #165)", () => {
  beforeEach(() => vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096"));

  it("splits a cut-off batch and regenerates each half, down to one module", async () => {
    // One batch at a time, so the call order below is the sequential one.
    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "1");
    const facts = pairs(6);
    const plan = planSectionBatches(facts, RULES, 150_000, 4_096);
    expect(plan.batches.map((b) => b.length)).toEqual([2, 2, 2]);
    const provider = fakeModel({ cutOff: (c) => c.group === RULES.label && c.modules.length > 1 });
    const result = await run(facts, provider);
    const calls = callsFor(provider, RULES);
    expect(calls.map((c) => c.modules.length)).toEqual([2, 1, 1, 2, 1, 1, 2, 1, 1]);
    expect(result.warnings.filter((w) => w.section === RULES.label)).toEqual([]);
    for (const f of facts) expect(result.markdown).toContain(`Rule from ${f.moduleName}**`);
  });

  it("costs at most 3x the planned calls when the model ALWAYS runs to the cap, and names what was cut off", async () => {
    const facts = pairs(6);
    const provider = fakeModel({ cutOff: (c) => c.group === RULES.label });
    const result = await run(facts, provider);
    expect(callsFor(provider, RULES)).toHaveLength(9);
    const warning = result.warnings.find(
      (w) => w.section === RULES.label && w.kind === "section-truncated",
    )!;
    expect(warning.severity).toBe("error");
    for (const f of facts) expect(warning.message).toContain(`"${f.moduleName}"`);
    expect(warning.message).toContain("alone write more than one call can hold");
  });

  it("stops splitting when the section's re-split budget is spent, and says which batch could not be split", async () => {
    // One planned batch of four: one re-split is allowed, so the halves stay whole.
    vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "8192");
    const facts = pairs(4);
    expect(planSectionBatches(facts, RULES, 150_000, 8_192).batches.map((b) => b.length)).toEqual([
      4,
    ]);
    const provider = fakeModel({ cutOff: (c) => c.group === RULES.label });
    const result = await run(facts, provider);
    expect(callsFor(provider, RULES).map((c) => c.modules.length)).toEqual([4, 2, 2]);
    const warning = result.warnings.find((w) => w.section === RULES.label)!;
    // PR #169 review: the halves COULD be split — the allowance ran out.
    expect(warning.message).toContain(
      'the batches covering "p0", "p1", "p2", "p3" were not split again because the section\'s re-split allowance',
    );
    expect(warning.message).not.toContain("could not be split");
  });

  it("does not split a batch too small for its size to explain the cut-off (a runaway model)", async () => {
    const facts = [mod("tiny1", { rules: 1 }), mod("tiny2", { rules: 1 })];
    const provider = fakeModel({ cutOff: (c) => c.group === RULES.label });
    const result = await run(facts, provider);
    expect(callsFor(provider, RULES)).toHaveLength(1);
    const warning = result.warnings.find((w) => w.section === RULES.label)!;
    expect(warning.message).toContain('the batch covering "tiny1", "tiny2" was cut off although');
    expect(warning.message).not.toContain("allowance");
  });

  it("names a single module whose own reply is too large for the cap", async () => {
    // One fact that cannot be paged (a single bullet longer than a batch).
    const monster = mod("monster", { rules: 0 });
    monster.facts = monster.facts.replace(
      "RULES\n",
      `RULES\n- ${pad(80_000, "one enormous rule")}\n`,
    );
    const facts = [monster, ...pairs(2)];
    const provider = fakeModel();
    const result = await run(facts, provider);
    const warning = result.warnings.find(
      (w) => w.section === RULES.label && w.kind === "section-truncated",
    )!;
    expect(warning.message).toMatch(/module "monster" alone writes more than one call can hold/);
    expect(warning.message).not.toContain('"p0"');
  });
});

describe("what each batch is told and given", () => {
  beforeEach(() => vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096"));

  it("lets only the batch holding the most relevant module write the introduction", async () => {
    const provider = fakeModel();
    await run(pairs(6), provider);
    const calls = callsFor(provider, RULES);
    expect(calls).toHaveLength(3);
    expect(calls[0].user).toContain("=== BATCH INSTRUCTIONS ===");
    expect(calls[0].user).not.toContain("Do NOT write an introduction");
    for (const c of calls.slice(1)) expect(c.user).toContain("Do NOT write an introduction");
  });

  it("sends each batch only its own modules' source formulas", async () => {
    const facts = pairs(4).map((f) => ({
      ...f,
      formulas: [
        {
          kind: "arithmetic" as const,
          expression: `total_${f.moduleName} = price * qty`,
          description: "",
          name: null,
          resolvedValue: null,
          filePath: `${f.modulePath}/x.ts`,
        },
      ],
    })) as unknown as ModuleFacts[];
    const provider = fakeModel();
    await run(facts, provider);
    const [first, second] = callsFor(provider, RULES);
    const formulasOf = (user: string) =>
      user.slice(user.indexOf("=== FORMULAS/CONSTANTS"), user.indexOf("=== END FORMULAS ==="));
    expect(formulasOf(first.user)).toContain("total_p0");
    expect(formulasOf(first.user)).toContain("total_p1");
    expect(formulasOf(first.user)).not.toContain("total_p2");
    expect(formulasOf(second.user)).toContain("total_p3");
    expect(formulasOf(second.user)).not.toContain("total_p0");
  });
});

describe("section reuse (#1226 records) through the batched path", () => {
  beforeEach(() => vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096"));

  const runWithReuse = (
    facts: ModuleFacts[],
    provider: AIProvider,
    previous?: Awaited<ReturnType<typeof synthesizeFinalDocument>>,
  ) =>
    synthesizeFinalDocument(
      facts,
      META,
      "business-requirements",
      "BRD",
      routerFor(provider),
      "p1",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        effectiveConfigHash: "cfg",
        previousManifest: previous
          ? ({ sectionSynthesis: previous.sectionSynthesis } as never)
          : undefined,
      },
    );

  it("records a batched section and reads it back unchanged on the next run", async () => {
    const facts = pairs(4);
    const first = await runWithReuse(facts, fakeModel());
    expect(first.sectionSynthesis?.records.map((r) => r.sectionId)).toContain("rules");
    const second = fakeModel();
    const again = await runWithReuse(facts, second, first);
    expect(callsFor(second, RULES)).toEqual([]);
    expect(again.regeneration).toEqual({ mode: "unchanged", changed: [] });
    expect(sectionOf(again.markdown, RULES.label)).toBe(sectionOf(first.markdown, RULES.label));
  });

  it("regenerates a batched section when any one batch's facts change", async () => {
    const facts = pairs(4);
    const first = await runWithReuse(facts, fakeModel());
    const changed = facts.map((f, i) =>
      i === 3 ? { ...f, facts: f.facts.replace("rule 0 of p3", "rule 0 (edited) of p3") } : f,
    );
    const second = fakeModel();
    await runWithReuse(changed, second, first);
    expect(callsFor(second, RULES).length).toBeGreaterThan(0);
  });
});

// ── Failures ──────────────────────────────────────────────────────────────

describe("a failed batch", () => {
  beforeEach(() => vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096"));

  it("costs only its own modules, named in a warning without the exception text", async () => {
    const facts = pairs(4);
    const provider = fakeModel({
      fail: (c) => c.group === RULES.label && c.modules.includes("p0"),
    });
    const result = await run(facts, provider);
    const rules = sectionOf(result.markdown, RULES.label);
    expect(rules).toContain("Rule from p2**");
    expect(rules).toContain("Rule from p3**");
    expect(rules).not.toContain("Rule from p0**");
    expect(rules).not.toContain("Rule from p1**");
    const warning = result.warnings.find(
      (w) => w.section === RULES.label && w.kind === "section-failed",
    )!;
    expect(warning.message).toContain('"p0", "p1"');
    expect(warning.message).not.toContain("secret stack trace");
  });

  // PR #169 review: an empty reply counted as done and was then filtered out
  // before the merge, so its modules vanished with no warning at all.
  it("names the modules of a batch whose reply was EMPTY", async () => {
    const facts = pairs(4);
    const provider = fakeModel({
      empty: (c) => c.group === RULES.label && c.modules.includes("p2"),
    });
    const result = await run(facts, provider);
    const rules = sectionOf(result.markdown, RULES.label);
    expect(rules).toContain("Rule from p0**");
    expect(rules).not.toContain("Rule from p2**");
    const warning = result.warnings.find(
      (w) => w.section === RULES.label && w.kind === "section-failed",
    )!;
    expect(warning.severity).toBe("error");
    expect(warning.message).toContain('"p2", "p3"');
    expect(warning.message).toContain("no content");
    expect(warning.message).not.toContain('"p0"');
  });

  it("raises ONE empty-section warning, not one per batch, when every reply is empty", async () => {
    const provider = fakeModel({ empty: (c) => c.group === RULES.label });
    const result = await run(pairs(4), provider);
    const warnings = result.warnings.filter((w) => w.section === RULES.label);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("could not be generated");
  });

  it("fails the section as before when every batch fails", async () => {
    const provider = fakeModel({ fail: (c) => c.group === RULES.label });
    const result = await run(pairs(4), provider);
    const failed = result.warnings.filter((w) => w.section === RULES.label);
    expect(failed).toHaveLength(1);
    expect(failed[0].message).toContain("could not be generated");
    expect(result.markdown).not.toContain("## Business Rules & Policies");
  });
});

// ── Per-batch grounding ──────────────────────────────────────────────────

const verified = (total: number, supported: number): FaithfulnessResult => ({
  section: "x",
  totalClaims: total,
  supportedClaims: supported,
  faithfulness: supported / total,
  verified: true,
  unsupportedClaims: [],
  supportedAttributions: [],
});

function ragGrounding(): GroundingContext {
  return {
    sources: [{ sourceId: "rag:doc:0", kind: "rag", label: "doc", text: "retrieved evidence" }],
    sourceIds: new Set(["rag:doc:0"]),
    isEmpty: false,
  } as unknown as GroundingContext;
}

describe("per-batch grounding", () => {
  beforeEach(() => vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096"));

  it("judges each batch's reply against ITS OWN facts and pools the section's score", async () => {
    const facts = pairs(4);
    const judged: Array<{ markdown: string; factIds: string[]; rag: boolean }> = [];
    scoreFaithfulnessMock.mockImplementation(
      async (section: string, markdown: string, ctx: GroundingContext) => {
        if (section !== RULES.label) return verified(1, 1);
        judged.push({
          markdown,
          factIds: ctx.sources.filter((s) => s.kind === "facts").map((s) => s.sourceId),
          rag: ctx.sources.some((s) => s.sourceId === "rag:doc:0"),
        });
        // Batch 1 fully supported, batch 2 fully unsupported: pooled 10/20.
        return judged.length === 1 ? verified(10, 10) : verified(10, 0);
      },
    );
    const result = await run(facts, fakeModel(), ragGrounding());
    expect(judged).toHaveLength(2);
    expect(judged[0].markdown).toContain("Rule from p0**");
    expect(judged[0].markdown).not.toContain("Rule from p2**");
    expect(judged[0].factIds).toHaveLength(2);
    expect(judged[1].factIds).toHaveLength(2);
    expect(new Set([...judged[0].factIds, ...judged[1].factIds]).size).toBe(4);
    expect(judged.every((j) => j.rag)).toBe(true);
    const warning = result.warnings.find(
      (w) => w.section === RULES.label && w.kind === "section-ungrounded",
    )!;
    expect(warning.message).toContain("(10 of 20)");
  });

  it("stays clean when the pooled score clears the bar", async () => {
    scoreFaithfulnessMock.mockResolvedValue(verified(10, 10));
    const result = await run(pairs(4), fakeModel(), ragGrounding());
    expect(result.warnings.filter((w) => w.section === RULES.label)).toEqual([]);
  });

  // PR #169 review: the section counted as verified if ANY batch was, so the
  // score silently covered only part of it.
  it("says which part went unchecked when one batch's scoring throws and another's does not", async () => {
    let n = 0;
    scoreFaithfulnessMock.mockImplementation(async (section: string) => {
      if (section !== RULES.label) return verified(1, 1);
      n += 1;
      if (n === 2) throw new Error("judge down");
      return verified(10, 10);
    });
    const result = await run(pairs(4), fakeModel(), ragGrounding());
    const warning = result.warnings.find(
      (w) => w.section === RULES.label && w.kind === "section-ungrounded",
    )!;
    expect(warning.severity).toBe("warning");
    expect(warning.message).toContain('"p2", "p3" could not be checked');
    expect(warning.message).toContain("covers only 1 of its 2 parts");
    expect(warning.message).not.toContain('"p0"');
  });

  it("says which part went unchecked when a batch comes back unverified", async () => {
    let n = 0;
    scoreFaithfulnessMock.mockImplementation(async (section: string) => {
      if (section !== RULES.label) return verified(1, 1);
      n += 1;
      return n === 1 ? { ...verified(0, 0), faithfulness: 1, verified: false } : verified(10, 10);
    });
    const result = await run(pairs(4), fakeModel(), ragGrounding());
    const warning = result.warnings.find(
      (w) => w.section === RULES.label && w.kind === "section-ungrounded",
    )!;
    expect(warning.message).toContain('"p0", "p1" could not be checked');
    expect(warning.message).toContain("covers only 1 of its 2 parts");
  });

  it("treats a batch whose scoring throws as unverified, not as a section failure", async () => {
    scoreFaithfulnessMock.mockRejectedValue(new Error("judge down"));
    const result = await run(pairs(4), fakeModel(), ragGrounding());
    expect(result.warnings.filter((w) => w.section === RULES.label)).toEqual([]);
    expect(result.markdown).toContain("## Business Rules & Policies");
  });
});

// ── Escalation (#334) ────────────────────────────────────────────────────

describe("judge-gated escalation of a batched section", () => {
  beforeEach(() => {
    vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096");
    vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "1");
  });

  function hybrid(local: AIProvider, cloud: AIProvider): Phase2Router {
    const b = (kind: Phase2ProviderBundle["kind"], provider: AIProvider): Phase2ProviderBundle => {
      const tuning = docsGenTuning(kind === "local" ? "local" : "anthropic", provider.model);
      return { kind, provider, supportsCaching: false, factsCharCap: tuning.factsCharCap, tuning };
    };
    const localBundle = b("local", local);
    return {
      primary: localBundle,
      hybrid: { local: localBundle, escalation: b("anthropic", cloud) },
    };
  }

  it("re-runs the whole batched section on the escalation provider and keeps the better one", async () => {
    const local = fakeModel({ marker: " [local]" });
    const cloud = fakeModel({ marker: " [cloud]" });
    scoreFaithfulnessMock.mockImplementation(async (_section: string, markdown: string) =>
      markdown.includes("[local]") ? verified(10, 1) : verified(10, 10),
    );
    const result = await synthesizeFinalDocument(
      pairs(4),
      META,
      "business-requirements",
      "BRD",
      hybrid(local, cloud),
      "p1",
      ragGrounding(),
    );
    expect(callsFor(cloud, RULES).length).toBeGreaterThan(1);
    const rules = result.sections.find((s) => s.sectionLabel === RULES.label)!;
    expect(rules.providerKind).toBe("anthropic");
    expect(result.warnings.filter((w) => w.section === RULES.label)).toEqual([]);
    expect(result.markdown).toContain("Rule from p0** [cloud]");
  });
});

// ── Refine (#118) and progress on the batched path ────────────────────────

/** A LOCAL provider (refine applies only to local-gemma) that records refine calls. */
function localModelWithRefine(options: FakeOptions = {}): {
  provider: AIProvider & { calls: Call[] };
  refines: string[];
  order: string[];
} {
  const inner = fakeModel(options);
  const refines: string[] = [];
  const order: string[] = [];
  const provider = {
    ...inner,
    key: "local-gemma",
    async *stream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<ChatChunk> {
      const system = String(messages[0].content);
      const user = String(messages[messages.length - 1].content);
      if (system.includes("documentation fixer")) {
        const label = /this "(.+?)" section/.exec(user)?.[1] ?? "?";
        refines.push(label);
        order.push(`refine:${label}`);
        yield { type: "delta", content: user.slice(user.indexOf("##")) };
        yield { type: "done", finishReason: "stop" };
        return;
      }
      order.push(`draft:${/Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?"}`);
      yield* inner.stream(messages, opts);
    },
  } as unknown as AIProvider & { calls: Call[] };
  return { provider, refines, order };
}

function localRouter(provider: AIProvider): Phase2Router {
  const tuning = { ...docsGenTuning("local", provider.model), refine: true };
  return {
    primary: { kind: "local", provider, supportsCaching: false, factsCharCap: 150_000, tuning },
  };
}

describe("the refine pass (#118) on the batched path", () => {
  it("never refines a batch reply; single-call groups are still refined", async () => {
    const { provider, refines } = localModelWithRefine();
    await synthesizeFinalDocument(
      onyourleftSized().slice(0, 12),
      META,
      "business-requirements",
      "BRD",
      localRouter(provider),
      "p1",
    );
    const batchedLabels = new Set(BATCHED.map((g) => g.label));
    expect(callsFor(provider, RULES).length).toBeGreaterThan(1);
    expect(refines.filter((l) => batchedLabels.has(l))).toEqual([]);
    const single = sectionGroupsFor("business-requirements").filter((g) => !g.batched);
    expect(refines.sort()).toEqual(single.map((g) => g.label).sort());
  });

  it("checks truncation first: a cut-off single-call draft is not refined", async () => {
    const overview = sectionGroupsFor("business-requirements").find((g) => !g.batched)!;
    const { provider, refines } = localModelWithRefine({
      cutOff: (c) => c.group === overview.label,
    });
    const result = await synthesizeFinalDocument(
      onyourleftSized().slice(0, 12),
      META,
      "business-requirements",
      "BRD",
      localRouter(provider),
      "p1",
    );
    expect(refines).not.toContain(overview.label);
    // The other single-call groups were complete, so they were refined.
    expect(refines.length).toBeGreaterThan(0);
    expect(
      result.warnings.some((w) => w.kind === "section-truncated" && w.section === overview.label),
    ).toBe(true);
  });
});

describe("per-batch progress", () => {
  it("reports every finished batch of a batched section, so progress moves within it", async () => {
    const updates: Array<{
      section: string;
      status: string;
      batch?: { done: number; total: number };
    }> = [];
    const provider = fakeModel({ cutOff: (c) => c.group === RULES.label && c.modules.length > 5 });
    await synthesizeFinalDocument(
      onyourleftSized(),
      META,
      "business-requirements",
      "BRD",
      routerFor(provider),
      "p1",
      undefined,
      (u) => updates.push(u),
    );
    const rules = updates.filter((u) => u.section === RULES.label && u.batch);
    const calls = callsFor(provider, RULES).length;
    // One update per batch that FINISHED; a cut-off call that was split is not
    // a finished batch — its two halves are.
    expect(rules.length).toBeGreaterThan(1);
    expect(calls).toBeGreaterThan(rules.length);
    // done counts up by one; total grows only when a cut-off batch is split.
    expect(rules.map((u) => u.batch!.done)).toEqual(rules.map((_, i) => i + 1));
    const last = rules[rules.length - 1].batch!;
    expect(last.done).toBe(last.total);
    expect(rules).toHaveLength(last.total);
    expect(last.total).toBeGreaterThan(rules[0].batch!.total); // a split happened
    // A cut-off batch counts as done once it is split, so each split adds one to the total.
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i].batch!.total).toBeGreaterThanOrEqual(rules[i - 1].batch!.total);
    }
  });
});

// ── #178 — batches run concurrently ───────────────────────────────────────

describe("#178 — a batched section's batches run through a bounded pool", () => {
  const rulesCalls = (p: { calls: Call[] }) => callsFor(p, RULES);
  /** Rules calls finish in REVERSE of the order they started. */
  const slowestFirst = () => {
    let started = 0;
    return (c: Call) => (c.group === RULES.label ? Math.max(1, 60 - 4 * started++) : 0);
  };

  it("keeps DOCS_GEN_PHASE2_CONCURRENCY batch calls in flight", async () => {
    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "3");
    const provider = fakeModel({ delayMs: () => 2 });
    await run(onyourleftSized(), provider);
    expect(rulesCalls(provider).length).toBeGreaterThan(3);
    expect(provider.peak).toBe(3);
  });

  it("defaults to 4 in flight on a cloud provider and 1 on local-gemma", async () => {
    const cloud = fakeModel({ delayMs: () => 2 });
    await run(onyourleftSized(), cloud);
    expect(cloud.peak).toBe(4);
    const local = fakeModel({ delayMs: () => 2 }, "local-gemma");
    await run(onyourleftSized(), local);
    expect(local.peak).toBe(1);
  });

  it("merges replies in PLAN order: batches finishing out of order give the sequential document", async () => {
    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "1");
    const sequential = await run(onyourleftSized(), fakeModel());

    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "8");
    const provider = fakeModel({ delayMs: slowestFirst() });
    const concurrent = await run(onyourleftSized(), provider);

    // The calls really did finish out of order...
    const started = rulesCalls(provider).map((c) => c.modules[0]);
    const finished = provider.finished
      .filter((c) => c.group === RULES.label)
      .map((c) => c.modules[0]);
    expect(finished).not.toEqual(started);
    expect([...finished].sort()).toEqual([...started].sort());
    // ...and the document is byte-identical to the one-at-a-time run.
    expect(sectionOf(concurrent.markdown, "Business Rules & Policies")).toBe(
      sectionOf(sequential.markdown, "Business Rules & Policies"),
    );
    expect(concurrent.markdown).toBe(sequential.markdown);
  });

  it("keeps split halves in plan order when a cut-off batch is re-split under concurrency", async () => {
    vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096");
    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "1");
    const cutOff = (c: Call) => c.group === RULES.label && c.modules.length > 1;
    const sequential = await run(pairs(6), fakeModel({ cutOff }));

    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "3");
    // The planned batches' own calls take 60/40/20ms and every half 1ms, so the
    // planned batches COMPLETE (halves included) in reverse plan order: a merge
    // in completion order would put p4/p5 first.
    let planned = 0;
    const delayMs = (c: Call) =>
      c.group !== RULES.label ? 0 : c.modules.length > 1 ? 60 - 20 * planned++ : 1;
    const provider = fakeModel({ cutOff, delayMs });
    const concurrent = await run(pairs(6), provider);
    expect(rulesCalls(provider).map((c) => c.modules.length)).toEqual([2, 2, 2, 1, 1, 1, 1, 1, 1]);
    expect(concurrent.markdown).toBe(sequential.markdown);
    const rules = sectionOf(concurrent.markdown, "Business Rules & Policies");
    const order = [...rules.matchAll(/Rule from (p\d+)\*\*/g)].map((m) => m[1]);
    expect(order).toEqual(["p0", "p1", "p2", "p3", "p4", "p5"]);
  });

  it("lets only one of two racing cut-off halves spend the section's LAST re-split", async () => {
    // PR #181 review: the budget must run short while two checks compete for
    // it. Three planned batches of five, all in flight; batch 0 is complete,
    // batches 1 and 2 are cut off and split (budget 3 -> 1). Their first
    // halves are then in flight together, both cut off, both checking at a
    // budget of 1: exactly one may split. A budget checked, then awaited, then
    // spent lets both split (4 re-splits, budget -1).
    vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "8192");
    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "3");
    const facts = pairs(15);
    expect(planSectionBatches(facts, RULES, 150_000, 8_192).batches.map((b) => b.length)).toEqual([
      5, 5, 5,
    ]);
    const firstBatch = new Set(["p0", "p1", "p2", "p3", "p4"]);
    const provider = fakeModel({
      cutOff: (c) =>
        c.group === RULES.label && c.modules.length > 1 && !firstBatch.has(c.modules[0]),
      delayMs: () => 2,
    });
    const result = await run(facts, provider);
    const sizes = rulesCalls(provider).map((c) => c.modules.length);
    // Every re-split adds two calls to the three planned ones.
    const resplits = (sizes.length - 3) / 2;
    expect(resplits).toBe(3);
    // Exactly one first half was split, into two single-module calls.
    expect(sizes.filter((n) => n === 1)).toHaveLength(2);
    const warning = result.warnings.find((w) => w.section === RULES.label)!;
    expect(warning.message).toContain("re-split allowance");
  });

  it("spends the section's re-split budget exactly once per re-split when cut-off batches race", async () => {
    // Three planned batches of five, every call cut off, all three in flight at
    // once: the budget (3) is spent by the three planned batches, so each half
    // is kept whole — 3 + 6 calls.
    vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "8192");
    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "3");
    const facts = pairs(15);
    expect(planSectionBatches(facts, RULES, 150_000, 8_192).batches.map((b) => b.length)).toEqual([
      5, 5, 5,
    ]);
    const provider = fakeModel({ cutOff: (c) => c.group === RULES.label, delayMs: () => 2 });
    const result = await run(facts, provider);
    const sizes = rulesCalls(provider).map((c) => c.modules.length);
    expect(sizes.slice(0, 3)).toEqual([5, 5, 5]);
    expect(sizes.slice(3).sort()).toEqual([2, 2, 2, 3, 3, 3]);
    const warning = result.warnings.find((w) => w.section === RULES.label)!;
    expect(warning.message).toContain("re-split allowance");
    expect(warning.message).toContain('"p0"');
  });

  it("reports per-batch progress monotonically while batches finish out of order and split", async () => {
    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "6");
    const updates: Array<{ section: string; batch?: { done: number; total: number } }> = [];
    const provider = fakeModel({
      cutOff: (c) => c.group === RULES.label && c.modules.length > 5,
      delayMs: slowestFirst(),
    });
    await synthesizeFinalDocument(
      onyourleftSized(),
      META,
      "business-requirements",
      "BRD",
      routerFor(provider),
      "p1",
      undefined,
      (u) => updates.push(u),
    );
    const rules = updates.filter((u) => u.section === RULES.label && u.batch).map((u) => u.batch!);
    expect(rules.length).toBeGreaterThan(1);
    expect(rules.map((b) => b.done)).toEqual(rules.map((_, i) => i + 1));
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i].total).toBeGreaterThanOrEqual(rules[i - 1].total);
    }
    for (const b of rules) expect(b.done).toBeLessThanOrEqual(b.total);
    expect(rules[rules.length - 1].done).toBe(rules[rules.length - 1].total);
  });
});

describe("#178 — every Phase-2 call's recorded usage counts toward the run's cost", () => {
  it("adds each section and batch call, concurrent ones included, to the run", async () => {
    vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "4");
    const provider = fakeModel({
      delayMs: () => 1,
      usage: {
        promptTokens: 1_000,
        completionTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 50,
      },
    });
    const usage = new RunUsage();
    await withRunUsage(usage, () => run(onyourleftSized(), provider));
    const n = provider.calls.length;
    expect(n).toBeGreaterThan(10);
    expect(usage.lines()).toEqual([
      {
        provider: "anthropic",
        model: "fake-section-model",
        calls: n,
        inputTokens: 1_000 * n,
        outputTokens: 200 * n,
        cacheReadTokens: 300 * n,
        cacheWriteTokens: 50 * n,
      },
    ]);
  });
});
