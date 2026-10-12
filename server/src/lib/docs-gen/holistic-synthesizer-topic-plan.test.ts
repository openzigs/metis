/**
 * #1070 — a business-requirements document written under the topic plan,
 * through `synthesizeFinalDocument`: budgets in the prompts, parts held to
 * their own budgets, planned-out and cut topics listed, the canonical facts
 * sheet in the prompts, the citable sources and the reuse inputs, and the
 * consistency note. The fake model writes one H3 topic per module it is given
 * and can be told to overrun the budget its prompt states. No network, no
 * database, no live model.
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

import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";
import { MIN_TOPIC_CHARS } from "./document-plan.js";
import type { PersistedMinedRule } from "./fact-slices.js";
import type { FaithfulnessResult } from "./grounding/citation-validator.js";
import { deriveDocStatus } from "./grounding/degraded-warnings.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  documentTypeIsPlanned,
  planDocumentTopics,
  planSectionBatches,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type DocType,
  type GenerationStepHook,
  type ModuleFacts,
  type Phase2ProviderBundle,
  type Phase2Router,
} from "./holistic-synthesizer.js";

// ── Fixture ───────────────────────────────────────────────────────────────

const bullets = (kind: string, name: string, n: number, extra = ""): string =>
  Array.from(
    { length: n },
    (_, i) =>
      `- ${kind} ${i} of ${name}: the request is checked against the configured policy${extra}.`,
  ).join("\n");

/** One module with every topic slice, sized by bullet counts. */
function mod(
  name: string,
  size: number,
  over: Partial<ModuleFacts> & { rules?: string; workflows?: string; integrations?: string } = {},
): ModuleFacts {
  const { rules, workflows, integrations, ...rest } = over;
  const facts = [
    "PURPOSE",
    `${name} handles one business capability.`,
    "RULES",
    `${bullets("rule", name, size)}${rules ? `\n${rules}` : ""}`,
    "WORKFLOWS",
    `${bullets("step", name, size)}${workflows ? `\n${workflows}` : ""}`,
    "FORMULAS",
    bullets("formula", name, Math.max(1, size >> 1)),
    "ENTITIES",
    bullets("entity", name, Math.max(1, size >> 1)),
    "INTEGRATIONS",
    `${bullets("integration", name, 1)}${integrations ? `\n${integrations}` : ""}`,
    "KEY_APIS",
    bullets("api", name, 1),
  ].join("\n");
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 4,
    facts,
    formulas: [],
    topClasses: [],
    ...rest,
  };
}

const constant = (name: string, value: string): PersistedMinedRule => ({
  language: "go",
  kind: "const",
  expression: `const ${name} = ${value}`,
  summary: `Constant \`${name}\` = ${value}`,
  file: "src/m00/limits.go",
  line: 12,
  context: null,
});

/** `count` modules, larger first, so the relevance order is m00, m01, … */
const project = (count: number): ModuleFacts[] =>
  Array.from({ length: count }, (_, i) => mod(`m${String(i).padStart(2, "0")}`, 2 * count - i));

// ── Fake model ────────────────────────────────────────────────────────────

interface Call {
  group: string;
  modules: string[];
  system: string;
  user: string;
}

interface FakeOptions {
  /** Characters written per module when the prompt states no budget. */
  perModule?: number;
  /** Write this many times the budget the prompt states (default: keep to it). */
  overrun?: number | ((call: Call) => number);
  /** Extra text for a call's first paragraph. */
  inject?: (call: Call) => string;
}

const PARAGRAPH = "This policy applies to every request the capability receives today. ";

function fakeModel(options: FakeOptions = {}, key = "anthropic"): AIProvider & { calls: Call[] } {
  const calls: Call[] = [];
  const reply = (call: Call): string => {
    const limit = /write at most about (\d+) words/i.exec(call.user);
    const modules = call.modules.length > 0 ? call.modules : ["everything"];
    const factor =
      typeof options.overrun === "function" ? options.overrun(call) : (options.overrun ?? 0.8);
    const total = limit
      ? Number(limit[1]) * 6 * factor
      : (options.perModule ?? 400) * modules.length;
    const each = Math.max(120, Math.floor(total / modules.length));
    const paragraphs = Math.max(1, Math.round(each / 150));
    const topics = modules.map((m, i) =>
      [
        `### About ${m}`,
        ...Array.from(
          { length: paragraphs },
          (_, p) =>
            `${m} rule ${p}. ${p === 0 && i === 0 ? (options.inject?.(call) ?? "") : ""}${PARAGRAPH.repeat(2)}`,
        ),
      ].join("\n\n"),
    );
    return `## ${call.group}\n\n${topics.join("\n\n")}`;
  };
  const provider = {
    key,
    model: "fake-section-model",
    offline: false,
    calls,
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      const system = String(messages[0].content);
      const facts = user.slice(
        user.indexOf("=== EXTRACTED MODULE FACTS ==="),
        user.indexOf("=== END MODULE FACTS ==="),
      );
      const call: Call = {
        group: /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?",
        modules: [...new Set([...facts.matchAll(/^### MODULE: (\S+)/gm)].map((m) => m[1]))],
        system,
        user,
      };
      calls.push(call);
      yield { type: "delta", content: reply(call) };
      yield { type: "done", finishReason: "stop" };
    },
    async chat(): Promise<never> {
      throw new Error("chat not used: the plan makes no model call");
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
  return provider as unknown as AIProvider & { calls: Call[] };
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
  return { primary: bundle, hybrid: null };
}

const META = { name: "Fixture", totalFiles: 40, totalSymbols: 900, language: "go" } as never;
const GROUPS = sectionGroupsFor("business-requirements");
const label = (id: string): string => GROUPS.find((g) => g.id === id)!.label;
const RULES = label("rules");

type Result = Awaited<ReturnType<typeof synthesizeFinalDocument>>;

async function run(
  facts: ModuleFacts[],
  provider: AIProvider,
  extra: {
    docType?: DocType;
    grounding?: GroundingContext;
    previous?: Result;
    beforeStep?: GenerationStepHook;
  } = {},
): Promise<Result> {
  return synthesizeFinalDocument(
    facts,
    META,
    extra.docType ?? "business-requirements",
    "BRD",
    routerFor(provider),
    "p1",
    extra.grounding,
    undefined,
    undefined,
    undefined,
    {
      effectiveConfigHash: "cfg",
      ...(extra.previous
        ? { previousManifest: { sectionSynthesis: extra.previous.sectionSynthesis } as never }
        : {}),
      ...(extra.beforeStep ? { beforeStep: extra.beforeStep } : {}),
    },
  );
}

/** The markdown of one H2 section of an assembled document. */
function sectionOf(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const next = markdown.indexOf("\n## ", start + 3);
  return markdown.slice(start, next < 0 ? undefined : next);
}

const callsFor = (p: { calls: Call[] }, group: string): Call[] =>
  p.calls.filter((c) => c.group === group);

const verified = (supported: number, total: number): FaithfulnessResult => ({
  section: "s",
  totalClaims: total,
  supportedClaims: supported,
  faithfulness: total === 0 ? 1 : supported / total,
  verified: true,
  unsupportedClaims: [],
  supportedAttributions: [],
});

beforeEach(() => {
  scoreFaithfulnessMock.mockReset();
  // Two or three modules to a batch, so a catalogue section has several parts.
  vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "6000");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "16384");
});
afterEach(() => vi.unstubAllEnvs());

// ── Tests ─────────────────────────────────────────────────────────────────

describe("which documents are planned", () => {
  it("plans business requirements only, and not when switched off", () => {
    expect(documentTypeIsPlanned("business-requirements")).toBe(true);
    expect(documentTypeIsPlanned("architecture")).toBe(false);
    expect(documentTypeIsPlanned("user-guide")).toBe(false);
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    expect(documentTypeIsPlanned("business-requirements")).toBe(false);
  });
});

describe("planDocumentTopics", () => {
  const plan = (facts: ModuleFacts[], documentMaxChars = 250_000) =>
    planDocumentTopics({
      facts,
      groups: GROUPS,
      router: routerFor(fakeModel()),
      sectionMaxChars: 60_000,
      documentMaxChars,
    });

  it("gives every module one topic in each catalogue section, owned by that section", () => {
    const facts = project(12);
    const { plan: p, budgets } = plan(facts);
    const kinds = Object.fromEntries(p.sections.map((s) => [s.sectionId, s.kind]));
    expect(kinds).toEqual({
      overview: "single",
      capabilities: "single",
      rules: "enumerative",
      workflows: "enumerative",
      formulas: "enumerative",
      "data-model": "enumerative",
      "integrations-and-glossary": "single",
    });
    const topics = p.sections.flatMap((s) => s.topics);
    expect(new Set(topics.map((t) => t.id)).size).toBe(topics.length);
    for (const s of p.sections.filter((x) => x.kind === "enumerative")) {
      expect(s.topics).toHaveLength(12);
      for (const t of s.topics) expect(t.id.startsWith(`${s.sectionId}/`)).toBe(true);
      // Ranked as the section ranks its modules: the largest module first.
      expect(s.topics[0].title).toBe(`m00 — ${s.label}`);
      expect(budgets.get(s.sectionId)!.get(facts[0])).toBe(s.topics[0].budgetChars);
    }
    const total = p.sections.reduce((n, s) => n + s.budgetChars, 0);
    expect(total + p.unallocatedChars).toBe(p.budgetChars);
  });

  it("sets aside room for the footnote definitions, at most a twentieth of the document", () => {
    const facts = project(12);
    expect(250_000 - plan(facts).plan.budgetChars).toBe(
      facts.reduce((n, f) => n + f.modulePath.length + 34, 0),
    );
    // 40 modules' definitions would be 1,640 characters: the share caps it.
    expect(10_000 - plan(project(40), 10_000).plan.budgetChars).toBe(500);
  });

  it("names a module at the repository root", () => {
    const { plan: p } = plan([mod("", 4, { modulePath: "", moduleName: "" })]);
    expect(p.sections.find((s) => s.sectionId === "rules")!.topics[0].title).toBe(
      `(root) — ${RULES}`,
    );
  });

  it("plans two modules that share a path as two topics, each with its budget", () => {
    // Possible only without repository provenance (two repositories, one path).
    const twins = [mod("shared", 6), mod("shared", 5)];
    const { plan: p, budgets } = plan(twins);
    const rules = p.sections.find((s) => s.sectionId === "rules")!;
    expect(rules.topics).toHaveLength(2);
    expect(new Set(rules.topics.map((t) => t.id)).size).toBe(2);
    expect(rules.dropped).toEqual([]);
    for (const twin of twins) expect(budgets.get("rules")!.get(twin)).toBeGreaterThan(0);
  });

  it("treats a catalogue section as one call when batching is switched off", () => {
    vi.stubEnv("DOCS_GEN_BATCHED_SECTIONS", "off");
    expect(plan(project(4)).plan.sections.every((s) => s.kind === "single")).toBe(true);
  });
});

describe("planSectionBatches under a topic plan", () => {
  it("sizes each module to its planned share and leaves out the modules the plan left out", () => {
    const facts = project(6);
    const group = GROUPS.find((g) => g.id === "rules")!;
    const unplanned = planSectionBatches(facts, group, 6_000, 16_384, 60_000);
    const shares = new Map(facts.map((f, i) => [f, i < 4 ? 500 : null] as const));
    const planned = planSectionBatches(facts, group, 6_000, 16_384, 60_000, {
      budgetChars: 2_000,
      budgetOf: (m) => shares.get(m) ?? null,
    });
    expect(planned.plannedOut).toEqual(["m04", "m05"]);
    expect([...new Set(planned.modules.map((m) => m.item.moduleName))]).toEqual([
      "m00",
      "m01",
      "m02",
      "m03",
    ]);
    for (const f of facts.slice(0, 4)) {
      const chars = planned.modules
        .filter((m) => m.item === f)
        .reduce((n, m) => n + m.outputChars, 0);
      expect(chars).toBeGreaterThanOrEqual(500);
      expect(chars).toBeLessThan(520);
    }
    // The budget the prompts state is the plan's, and the estimate is the
    // whole section's, planned-out modules included.
    expect(planned.sectionBudget).toEqual({
      maxChars: 2_000,
      scale: 2_000 / unplanned.modules.reduce((n, m) => n + m.outputChars, 0),
      estimatedChars: unplanned.modules.reduce((n, m) => n + m.outputChars, 0),
    });
    expect(unplanned.plannedOut).toBeUndefined();
  });

  it("states no budget when every module is planned what it was estimated to need", () => {
    const facts = project(3);
    const group = GROUPS.find((g) => g.id === "rules")!;
    const planned = planSectionBatches(facts, group, 6_000, 16_384, 60_000, {
      budgetChars: 1_000_000,
      budgetOf: () => 1_000_000,
    });
    expect(planned.sectionBudget).toBeUndefined();
    expect(planned.plannedOut).toBeUndefined();
  });
});

describe("a document written under the plan", () => {
  it("makes no model call to plan, and states the budgets in the prompts", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const provider = fakeModel();
    const seen: number[] = [];
    await run(project(12), provider, {
      beforeStep: async () => {
        seen.push(provider.calls.length);
      },
    });
    // Nothing had been sent when the first section was announced.
    expect(seen[0]).toBe(0);
    // Every call writes a section or a part of one.
    for (const call of provider.calls) expect(GROUPS.map((g) => g.label)).toContain(call.group);

    const overview = callsFor(provider, label("overview"));
    expect(overview).toHaveLength(1);
    expect(overview[0].user).toMatch(
      /=== LENGTH LIMIT ===\nWrite at most about \d+ words for this section group\./,
    );
    const rules = callsFor(provider, RULES);
    expect(rules.length).toBeGreaterThan(2);
    for (const call of rules) {
      expect(call.user).toMatch(/LENGTH LIMIT: write at most about \d+ words for THIS part/);
      const shares = /PLANNED SHARE of that limit by module \(approximate words\): ([^.]+)\./.exec(
        call.user,
      )![1];
      // Each module of the part, and only those, with its share.
      expect(shares.split("; ").map((s) => s.split(" ")[0])).toEqual(call.modules);
      expect(call.user).not.toContain("=== LENGTH LIMIT ===");
    }
    // Every module is read by exactly one part.
    expect(rules.flatMap((c) => c.modules).sort()).toEqual(
      project(12)
        .map((f) => f.moduleName)
        .sort(),
    );
  });

  it("holds each part to its own budget: no part's leading topic is lost to another's overrun", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "20000");
    const facts = project(12);
    const overrun = { overrun: 3, perModule: 3_000 };

    const planned = fakeModel(overrun);
    const withPlan = await run(facts, planned);
    const rules = sectionOf(withPlan.markdown, RULES);
    const leads = callsFor(planned, RULES).map((c) => c.modules[0]);
    expect(leads.length).toBeGreaterThan(2);
    for (const lead of leads) expect(rules).toContain(`### About ${lead}\n`);

    // The same model without the plan: the section is cut at its tail, and the
    // parts written from the lowest-ranked modules go whole.
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    const unplanned = fakeModel(overrun);
    const without = await run(facts, unplanned);
    const cut = sectionOf(without.markdown, RULES);
    const lost = callsFor(unplanned, RULES)
      .map((c) => c.modules[0])
      .filter((lead) => !cut.includes(`### About ${lead}\n`));
    expect(lost.length).toBeGreaterThan(0);
  });

  it("lists every topic a part lost, once, and loses none silently", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const facts = project(12);
    const provider = fakeModel({ overrun: 3 });
    const result = await run(facts, provider);
    const entry = result.sections.find((s) => s.sectionLabel === RULES)!;
    const rules = sectionOf(result.markdown, RULES);
    expect(entry.omittedTopics!.length).toBeGreaterThan(0);
    expect(rules.match(/\*\*Shortened for length\.\*\*/g)).toHaveLength(1);
    expect(rules).toContain(`${entry.omittedTopics!.length} further topic`);
    // The model wrote one topic per module: each is in the section or listed.
    for (const f of facts) {
      const topic = `About ${f.moduleName}`;
      const present = rules.includes(`### ${topic}\n`);
      expect(present || entry.omittedTopics!.includes(topic)).toBe(true);
      expect(present && entry.omittedTopics!.includes(topic)).toBe(false);
    }
    // The body stays within the document cap (the footer is not counted).
    const body = result.markdown.slice(result.markdown.indexOf("\n## "));
    expect(body.length).toBeLessThanOrEqual(40_000 + 400);
  });

  it("cuts nothing and writes no note when the model keeps to its budgets", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const result = await run(project(12), fakeModel());
    expect(result.markdown).not.toContain("Shortened for length");
    expect(result.sections.every((s) => !s.omittedTopics)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("gives a section the room an earlier one left unused", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const facts = project(12);
    // Rules overruns threefold; the single-call sections before it write little.
    const result = await run(
      facts,
      fakeModel({ overrun: (call) => (call.group === RULES ? 3 : 0.3) }),
    );
    const { plan } = planDocumentTopics({
      facts,
      groups: GROUPS,
      router: routerFor(fakeModel()),
      sectionMaxChars: 60_000,
      documentMaxChars: 40_000,
    });
    const budget = plan.sections.find((s) => s.sectionId === "rules")!.budgetChars;
    const overviewBudget = plan.sections.find((s) => s.sectionId === "overview")!.budgetChars;
    const overview = sectionOf(result.markdown, "Overview & Domain").length;
    expect(overview).toBeLessThan(overviewBudget / 2);
    // Rules ran past its own budget, into what the first two sections left.
    const rules = sectionOf(result.markdown, RULES).length;
    expect(rules).toBeGreaterThan(budget);
    // And no further than its share of it: four sections were still to come.
    const spare = 2 * overviewBudget;
    expect(rules).toBeLessThanOrEqual(budget + Math.ceil(spare / 5));
  });

  it("leaves out the lowest-priority modules at planning time, never reads them, and lists them", async () => {
    // One fixture past the topic floor: 60 modules cannot each have
    // MIN_TOPIC_CHARS of a section of a 30,000-character document.
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "30000");
    const facts = project(60);
    const provider = fakeModel();
    const result = await run(facts, provider);
    const read = new Set(callsFor(provider, RULES).flatMap((c) => c.modules));
    const sectionBudget = Math.floor((30_000 - 1_500) / GROUPS.length);
    expect(read.size).toBe(Math.floor(sectionBudget / MIN_TOPIC_CHARS));
    // The modules kept are the highest ranked.
    expect([...read].sort()).toEqual(
      facts
        .slice(0, read.size)
        .map((f) => f.moduleName)
        .sort(),
    );
    const entry = result.sections.find((s) => s.sectionLabel === RULES)!;
    const plannedOut = entry.omittedTopics!.filter((t) => t.endsWith("(not planned)"));
    expect(plannedOut).toHaveLength(60 - read.size);
    // Read or listed: every module is accounted for.
    for (const f of facts) {
      const listed = plannedOut.some((t) => t.startsWith(`${f.moduleName} `));
      expect(read.has(f.moduleName) !== listed).toBe(true);
    }
    const rules = sectionOf(result.markdown, RULES);
    expect(rules).toContain("**Shortened for length.**");
    expect(rules).toContain(`${entry.omittedTopics!.length} further topics were left out`);
  });

  it("says what was left out, not that the model wrote nothing, when no part fits its budget", async () => {
    // The smallest document the setting accepts: about 1,350 characters a
    // section, most of which the closing note needs. No part can keep a
    // paragraph, so the section is its heading and the list of what is missing
    // — never an empty section reported as a failed one.
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "10000");
    const result = await run(project(60), fakeModel());
    const rules = sectionOf(result.markdown, RULES);
    expect(rules).toContain("**Shortened for length.**");
    expect(rules).toContain("About m01");
    expect(result.warnings.filter((w) => w.kind === "section-failed")).toEqual([]);
    const entry = result.sections.find((s) => s.sectionLabel === RULES)!;
    expect(entry.omittedTopics!.some((t) => t.endsWith("(not planned)"))).toBe(true);
  });

  it("generates as before when the plan is switched off", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    const provider = fakeModel();
    const result = await run(project(12), provider);
    for (const call of provider.calls) {
      expect(call.user).not.toContain("PLANNED SHARE");
      expect(call.user).not.toContain("=== LENGTH LIMIT ===");
      expect(call.user).not.toContain("CANONICAL FACTS");
    }
    expect(result.warnings.some((w) => w.kind === "fact-inconsistent")).toBe(false);
  });
});

describe("other document types", () => {
  it.each(["architecture", "user-guide"] as const)(
    "writes a %s document exactly as with the plan switched off",
    async (docType) => {
      vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
      const facts = [
        ...project(8),
        mod("limits", 3, { minedRules: [constant("maxPageSize", "100")] }),
      ];
      const on = fakeModel({ overrun: 2 });
      const withPlan = await run(facts, on, { docType });
      vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
      const off = fakeModel({ overrun: 2 });
      const without = await run(facts, off, { docType });
      // The same prompts, the same document, and the same reuse inputs.
      expect(on.calls).toEqual(off.calls);
      expect(withPlan.markdown).toBe(without.markdown);
      expect(withPlan.warnings).toEqual(without.warnings);
      expect(withPlan.sectionSynthesis!.records.map((r) => r.inputs)).toEqual(
        without.sectionSynthesis!.records.map((r) => r.inputs),
      );
      // So a stored section is reused whichever way the setting stands.
      vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "on");
      const again = fakeModel();
      const reused = await run(facts, again, { docType, previous: without });
      expect(again.calls).toEqual([]);
      expect(reused.regeneration).toEqual({ mode: "unchanged", changed: [] });
    },
  );
});

describe("the canonical facts sheet in a planned document", () => {
  /**
   * `maxPageSize` is read from the source of m00; m00's rules and m01's
   * workflows mention it, so the sections that read those slices are given it.
   */
  const withLimit = (value: string): ModuleFacts[] => {
    const facts = project(6);
    facts[0] = mod("m00", 12, {
      rules: "- A page never holds more than `maxPageSize` entries.",
      minedRules: [constant("maxPageSize", value)],
    });
    facts[1] = mod("m01", 11, {
      workflows: "- Listing stops after `maxPageSize` entries and returns a cursor.",
    });
    return facts;
  };
  const given = (p: { calls: Call[] }): string[] => [
    ...new Set(p.calls.filter((c) => c.user.includes("=== CANONICAL FACTS")).map((c) => c.group)),
  ];

  it("gives the fact, with its source line and owner, to the sections whose input mentions it", async () => {
    const provider = fakeModel();
    await run(withLimit("100"), provider);
    expect(given(provider).sort()).toEqual(
      [label("capabilities"), RULES, label("workflows")].sort(),
    );
    const rules = callsFor(provider, RULES).find((c) => c.user.includes("CANONICAL FACTS"))!;
    expect(rules.user).toMatch(
      /\[facts:canon:cf-[0-9a-f]{10}\] maxPageSize = 100 \| src\/m00\/limits\.go:12 \| owner: THIS section/,
    );
    // Only the part whose modules mention it is given it.
    expect(rules.modules).toContain("m00");
    for (const call of callsFor(provider, RULES).filter((c) => c !== rules)) {
      expect(call.user).not.toContain("CANONICAL FACTS");
    }
    const workflows = callsFor(provider, label("workflows")).find((c) =>
      c.user.includes("CANONICAL FACTS"),
    )!;
    expect(workflows.user).toContain(`| owner: ${RULES}`);
    expect(workflows.user).toContain("Do not re-derive it");
  });

  it("rewrites exactly the sections given a fact when its value changes", async () => {
    const first = await run(withLimit("100"), fakeModel());
    const same = fakeModel();
    const unchanged = await run(withLimit("100"), same, { previous: first });
    expect(same.calls).toEqual([]);
    expect(unchanged.regeneration).toEqual({ mode: "unchanged", changed: [] });

    const changed = fakeModel();
    const second = await run(withLimit("200"), changed, { previous: first });
    expect(second.regeneration!.changed.sort()).toEqual(["capabilities", "rules", "workflows"]);
    expect([...new Set(changed.calls.map((c) => c.group))].sort()).toEqual(
      [label("capabilities"), RULES, label("workflows")].sort(),
    );
    expect(callsFor(changed, RULES).some((c) => c.user.includes("maxPageSize = 200"))).toBe(true);
  });

  it("without the plan, the same change reaches the rules section only", async () => {
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    const first = await run(withLimit("100"), fakeModel());
    const second = await run(withLimit("200"), fakeModel(), { previous: first });
    expect(second.regeneration!.changed).toEqual(["rules"]);
  });

  it("renders a cited fact as a footnote showing the source line, with fact-checking off", async () => {
    const cite = (call: Call): string => {
      const id = /\[(facts:canon:cf-[0-9a-f]{10})\] maxPageSize/.exec(call.user)?.[1];
      return id ? `A page holds at most 100 entries [${id}]. ` : "";
    };
    const result = await run(withLimit("100"), fakeModel({ inject: cite }));
    expect(result.markdown).not.toContain("facts:canon:");
    expect(result.markdown).toMatch(/A page holds at most 100 entries\[\^src-\d+\]\./);
    expect(result.markdown).toMatch(
      /^\[\^src-\d+\]: `src\/m00\/limits\.go:12 — maxPageSize = 100` \(canonical fact, read from the source\)$/m,
    );
    expect(
      result.selectedEvidence.filter((s) => s.sourceId.startsWith("facts:canon:")),
    ).toHaveLength(1);
  });

  it("gives the judge the fact as evidence for the part that was given it", async () => {
    scoreFaithfulnessMock.mockResolvedValue(verified(1, 1));
    const grounding = {
      sources: [{ sourceId: "rag:doc:0", kind: "rag", label: "notes.md", text: "evidence" }],
      sourceIds: new Set(["rag:doc:0"]),
      isEmpty: false,
    } as unknown as GroundingContext;
    const provider = fakeModel();
    const result = await run(withLimit("100"), provider, { grounding });
    const judged = scoreFaithfulnessMock.mock.calls.map(
      ([section, , ctx]: [string, string, GroundingContext]) => ({
        section,
        canonical: ctx.sources.filter((s) => s.sourceId.startsWith("facts:canon:")),
      }),
    );
    const withFact = judged.filter((j) => j.canonical.length > 0);
    expect([...new Set(withFact.map((j) => j.section))].sort()).toEqual(
      [label("capabilities"), RULES, label("workflows")].sort(),
    );
    expect(withFact[0].canonical[0].text).toBe(
      "CANONICAL FACT (read from the source code at src/m00/limits.go:12): maxPageSize = 100",
    );
    // The grounding block does not repeat it: it is in the block of its own.
    const rules = callsFor(provider, RULES).find((c) => c.user.includes("CANONICAL FACTS"))!;
    expect(rules.user).not.toContain("[SOURCE id=facts:canon:");
    const entry = result.sections.find((s) => s.sectionLabel === RULES)!;
    expect(entry.groundingSourceIds.some((id) => id.startsWith("facts:canon:"))).toBe(true);
    const formulas = result.sections.find((s) => s.sectionLabel === label("formulas"))!;
    expect(formulas.groundingSourceIds.some((id) => id.startsWith("facts:canon:"))).toBe(false);
  });
});

describe("judge-gated escalation of a planned document", () => {
  function hybrid(local: AIProvider, cloud: AIProvider): Phase2Router {
    const bundle = (kind: "local" | "anthropic", provider: AIProvider): Phase2ProviderBundle => {
      const tuning = docsGenTuning(kind, provider.model);
      return { kind, provider, supportsCaching: false, factsCharCap: tuning.factsCharCap, tuning };
    };
    const localBundle = bundle("local", local);
    return {
      primary: localBundle,
      hybrid: { local: localBundle, escalation: bundle("anthropic", cloud) },
    };
  }

  it("re-runs a section on the escalation provider with the same plan and the same facts", async () => {
    vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "1");
    vi.stubEnv("DOCS_GEN_LOCAL_FACTS_CHAR_CAP", "6000");
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const facts = project(6);
    facts[0] = mod("m00", 12, {
      rules: "- A page never holds more than `maxPageSize` entries.",
      integrations: "- The export client pages by `maxPageSize`.",
      minedRules: [constant("maxPageSize", "100")],
    });
    const local = fakeModel({ inject: () => "[local] " }, "local-gemma");
    const cloud = fakeModel();
    // The local drafts of two sections fall short (the run escalates at most
    // three); their escalated versions are supported.
    const judged: Array<{ section: string; local: boolean; canonical: number }> = [];
    scoreFaithfulnessMock.mockImplementation(
      async (section: string, markdown: string, ctx: GroundingContext) => {
        const isLocal = markdown.includes("[local]");
        judged.push({
          section,
          local: isLocal,
          canonical: ctx.sources.filter((s) => s.sourceId.startsWith("facts:canon:")).length,
        });
        const weak = section === RULES || section === label("integrations-and-glossary");
        return isLocal && weak ? verified(1, 10) : verified(10, 10);
      },
    );
    const grounding = {
      sources: [{ sourceId: "rag:doc:0", kind: "rag", label: "notes.md", text: "evidence" }],
      sourceIds: new Set(["rag:doc:0"]),
      isEmpty: false,
    } as unknown as GroundingContext;
    const result = await synthesizeFinalDocument(
      facts,
      META,
      "business-requirements",
      "BRD",
      hybrid(local, cloud),
      "p1",
      grounding,
    );

    // A batched section: the escalation is planned to the same shares.
    const rulesAgain = callsFor(cloud, RULES);
    expect(rulesAgain.length).toBeGreaterThan(0);
    for (const call of rulesAgain) expect(call.user).toContain("PLANNED SHARE of that limit");
    const withFact = rulesAgain.find((c) => c.modules.includes("m00"))!;
    expect(withFact.user).toMatch(/\[facts:canon:cf-[0-9a-f]{10}\] maxPageSize = 100/);
    expect(withFact.user).not.toContain("[SOURCE id=facts:canon:");
    expect(result.sections.find((s) => s.sectionLabel === RULES)!.providerKind).toBe("anthropic");

    // A single-call section: the same length limit and facts block, the fact
    // listed once (not again among the grounding sources), and the judge of
    // the escalated text is given it.
    const glossary = label("integrations-and-glossary");
    const [again] = callsFor(cloud, glossary);
    expect(again.user).toContain("=== LENGTH LIMIT ===");
    expect(again.user).toMatch(/\[facts:canon:cf-[0-9a-f]{10}\] maxPageSize = 100/);
    expect(again.user).not.toContain("[SOURCE id=facts:canon:");
    expect(judged.filter((j) => j.section === glossary)).toEqual([
      { section: glossary, local: true, canonical: 1 },
      { section: glossary, local: false, canonical: 1 },
    ]);
  });
});

describe("the consistency check in a planned document", () => {
  const disagree = (call: Call): string =>
    call.group === label("overview")
      ? "`POLLING_FREQUENCY` (default 60 min). "
      : call.group === label("integrations-and-glossary")
        ? "`POLLING_FREQUENCY` (default 30 min). "
        : "";

  it("notes a value stated differently in two sections, and changes nothing", async () => {
    const result = await run(project(6), fakeModel({ inject: disagree }));
    const notes = result.warnings.filter((w) => w.kind === "fact-inconsistent");
    expect(notes).toHaveLength(1);
    expect(notes[0].severity).toBe("info");
    expect(notes[0].message).toContain(
      "`POLLING_FREQUENCY` is given 2 different values (`60 min` in Overview & Domain; `30 min` in Integrations & Glossary).",
    );
    // A note, not a degradation; and the document carries no mark of it.
    expect(deriveDocStatus(result.warnings)).toBe("ready");
    expect(result.markdown).not.toContain("Consistency check");
    const quiet = await run(project(6), fakeModel());
    expect(quiet.warnings).toEqual([]);
    const strip = (md: string) =>
      md
        .replaceAll("`POLLING_FREQUENCY` (default 60 min). ", "")
        .replaceAll("`POLLING_FREQUENCY` (default 30 min). ", "");
    expect(strip(result.markdown)).toBe(quiet.markdown);
  });

  it("reports the same thing when every section is reused", async () => {
    const first = await run(project(6), fakeModel({ inject: disagree }));
    const again = fakeModel();
    const second = await run(project(6), again, { previous: first });
    expect(again.calls).toEqual([]);
    expect(second.warnings).toEqual(first.warnings);
  });

  it("does not run without the plan", async () => {
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    const result = await run(project(6), fakeModel({ inject: disagree }));
    expect(result.warnings).toEqual([]);
  });
});
