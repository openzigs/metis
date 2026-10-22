/**
 * #1070 — a business-requirements document written under the topic plan,
 * through `synthesizeFinalDocument`: budgets in the prompts as targets, nothing
 * cut while the document fits, each part's own tail cut when it does not,
 * planned-out and cut topics listed, the canonical facts sheet in the prompts,
 * the citable sources and the reuse inputs, and the consistency note. The fake model writes one H3 topic per module it is given
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
import { logger } from "../logger.js";
import { FLOOR_SHARE, MIN_TOPIC_CHARS, SINGLE_CALL_SECTION_CHARS } from "./document-plan.js";
import type { PersistedMinedRule } from "./fact-slices.js";
import type { FaithfulnessResult } from "./grounding/citation-validator.js";
import { deriveDocStatus } from "./grounding/degraded-warnings.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  documentTypeIsPlanned,
  footnoteReserveChars,
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

/**
 * `count` modules where module `from` and each of `rivals` holds one
 * enumeration value (owned by Data & Domain Model) that m00's rules and m01's
 * workflows mention, so every one is on the facts sheet: `exportFormatName` in
 * `from`, `rivalFormatA`, `rivalFormatB`, … in the rivals. Every holder is
 * planned before every other module (#1070), so among the holders it is the
 * relevance order that decides which one is left out.
 */
function withOwnedEnumerations(count: number, from: number, rivals: number[] = []): ModuleFacts[] {
  const facts = project(count);
  const name = (i: number): string => `m${String(i).padStart(2, "0")}`;
  const rivalName = (k: number): string => `rivalFormat${String.fromCharCode(65 + k)}`;
  rivals.forEach((i, k) => {
    facts[i] = mod(name(i), 2 * count - i, {
      minedRules: [constant(rivalName(k), `"r${k}"`)],
    });
  });
  facts[from] = mod(name(from), 2 * count - from, {
    minedRules: [constant("exportFormatName", '"ndjson"')],
  });
  const named = ["exportFormatName", ...rivals.map((_, k) => rivalName(k))]
    .map((n) => `\`${n}\``)
    .join(", ");
  facts[0] = mod("m00", 2 * count, { rules: `- Exports are written as ${named}.` });
  facts[1] = mod("m01", 2 * count - 1, {
    workflows: `- The export job names its file after ${named}.`,
  });
  return facts;
}

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
  /** Extra text for a call's LAST paragraph: the first text a length fit gives up. */
  injectLast?: (call: Call) => string;
  /** Write a call's reply as ONE table, which a length fit cannot cut into. */
  table?: (call: Call) => boolean;
  /** Appended to every paragraph: a citation marker, long as drafted, short as rendered. */
  marker?: string;
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
    if (options.table?.(call)) {
      const rows = Array.from({ length: 60 }, (_, r) => `| ${modules[0]} | limit ${r} |`);
      return `## ${call.group}\n\n### Table of ${modules[0]}\n\n| a | b |\n|---|---|\n${rows.join("\n")}`;
    }
    const each = Math.max(120, Math.floor(total / modules.length));
    const paragraphs = Math.max(1, Math.round(each / 150));
    const topics = modules.map((m, i) =>
      [
        `### About ${m}`,
        ...Array.from(
          { length: paragraphs },
          (_, p) =>
            `${m} rule ${p}. ${p === 0 && i === 0 ? (options.inject?.(call) ?? "") : ""}${
              p === paragraphs - 1 && i === modules.length - 1
                ? (options.injectLast?.(call) ?? "")
                : ""
            }${PARAGRAPH.repeat(2)}${options.marker ?? ""}`,
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
  // The plan ships off: every test here is about a document written with it on.
  vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "on");
});
afterEach(() => vi.unstubAllEnvs());

// ── Tests ─────────────────────────────────────────────────────────────────

describe("which documents are planned", () => {
  it("plans business requirements only, and only when switched on", () => {
    expect(documentTypeIsPlanned("business-requirements")).toBe(true);
    expect(documentTypeIsPlanned("architecture")).toBe(false);
    expect(documentTypeIsPlanned("user-guide")).toBe(false);
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    expect(documentTypeIsPlanned("business-requirements")).toBe(false);
    // Off is the default, and a value that is not `on` does not turn it on.
    vi.unstubAllEnvs();
    expect(process.env.DOCS_GEN_TOPIC_PLAN).toBeUndefined();
    expect(documentTypeIsPlanned("business-requirements")).toBe(false);
    for (const other of ["true", "1", "yes"]) {
      vi.stubEnv("DOCS_GEN_TOPIC_PLAN", other);
      expect(documentTypeIsPlanned("business-requirements")).toBe(false);
    }
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

  it("sets aside room for the footnote definitions, at most 8% of the document", () => {
    const facts = project(12);
    // Each module's own definition (its path and 34), and 100 for the pinned
    // lines, canonical facts and excerpts it brings (#1352).
    expect(250_000 - plan(facts).plan.budgetChars).toBe(
      facts.reduce((n, f) => n + f.modulePath.length + 34 + 100, 0),
    );
    expect(footnoteReserveChars(facts, 250_000)).toBe(12 * (7 + 134));
    // 40 modules' definitions would be 5,640 characters: the share caps it.
    expect(10_000 - plan(project(40), 10_000).plan.budgetChars).toBe(800);
  });

  it("#1352 — reserves what run B's definitions needed, so its plan fits the body it was given", () => {
    // Run B of #995 (2026-10-21): 102 modules whose paths come to 2,301
    // characters, so the module definitions alone reserved 5,769 and the plan
    // shared 244,231. The document's definitions then took 15,723 of the
    // 250,000 (logged `bodyMaxChars` 234,277): ~10k past the plan was cut at
    // the section ends however closely the model kept to it.
    const paths = Array.from({ length: 102 }, (_, i) => `internal/${String(i).padStart(2, "0")}`);
    const lengths = paths.reduce((n, p) => n + p.length, 0);
    const pad = 2_301 - lengths;
    paths[0] = paths[0] + "x".repeat(pad);
    const runB = paths.map((modulePath) => ({ modulePath }));
    expect(runB.reduce((n, m) => n + m.modulePath.length + 34, 0)).toBe(5_769);
    const reserved = footnoteReserveChars(runB, 250_000);
    expect(reserved).toBeGreaterThanOrEqual(250_000 - 234_277);
    expect(250_000 - reserved).toBeLessThanOrEqual(234_277);
  });

  it("sets that room aside from the modules alone: the facts sheet does not move a budget", () => {
    // The same modules, with and without a shared constant of any length.
    const withConstant = (value?: string): ModuleFacts[] => {
      const facts = project(12);
      facts[0] = mod("m00", 24, {
        rules: "- A page never holds more than `maxPageSize` entries.",
        workflows: "- Listing stops after `maxPageSize` entries.",
        ...(value === undefined ? {} : { minedRules: [constant("maxPageSize", value)] }),
      });
      return facts;
    };
    expect(plan(withConstant("100"), 20_000).sheet.facts).toHaveLength(1);
    for (const cap of [20_000, 250_000]) {
      // What is shared among the sections is the cap less the modules' own
      // footnotes: the same with no fact, a short one or a long one.
      const shared = plan(withConstant(), cap).plan.budgetChars;
      expect(plan(withConstant("100"), cap).plan.budgetChars).toBe(shared);
      expect(plan(withConstant("2000000"), cap).plan.budgetChars).toBe(shared);
    }
    // And under a binding cap every section's budget is the same too.
    const budgets = (facts: ModuleFacts[]): number[] =>
      plan(facts, 20_000).plan.sections.map((s) => s.budgetChars);
    expect(budgets(withConstant("100"))).toEqual(budgets(withConstant("2000000")));
  });

  it("names the section that owns a fact only when that section can state it", () => {
    // An enumeration value read from the LOWEST-ranked module, mentioned by
    // two other modules. Data & Domain Model owns enumerations.
    const facts = (count: number): ModuleFacts[] => withOwnedEnumerations(count, count - 1);
    // Room for every module: the data model reads m05 and owns the fact.
    const roomy = plan(facts(6));
    const [fact] = roomy.sheet.facts;
    expect(fact).toEqual(
      expect.objectContaining({ name: "exportFormatName", kind: "enumeration" }),
    );
    expect(roomy.ownerOf(fact)).toEqual({ id: "data-model", label: label("data-model") });
    // A 30,000-character document cannot plan all 60 modules into the data
    // model, nor all fifteen that hold a fact it owns: m59 is the lowest
    // ranked of those and is left out, so no section can state the fact as
    // its owner.
    const rivals = Array.from({ length: 14 }, (_, k) => 45 + k);
    const tight = plan(withOwnedEnumerations(60, 59, rivals), 30_000);
    const dataModel = tight.plan.sections.find((s) => s.sectionId === "data-model")!;
    expect(dataModel.dropped.map((t) => t.title)).toContain(`m59 — ${label("data-model")}`);
    const exportFormat = tight.sheet.facts.find((f) => f.name === "exportFormatName")!;
    expect(tight.ownerOf(exportFormat)).toBeNull();
    // Nor when the owning section is not part of the document at all.
    const withoutOwner = planDocumentTopics({
      facts: facts(6),
      groups: GROUPS.filter((g) => g.id !== "data-model"),
      router: routerFor(fakeModel()),
      sectionMaxChars: 60_000,
      documentMaxChars: 250_000,
    });
    expect(withoutOwner.ownerOf(withoutOwner.sheet.facts[0])).toBeNull();
  });

  it("plans a module holding a fact its section owns before every module that holds none", () => {
    // m59 is the least relevant of 60 and holds the one enumeration value.
    const tight = plan(withOwnedEnumerations(60, 59), 30_000);
    const section = (id: string) => tight.plan.sections.find((s) => s.sectionId === id)!;
    const title = (id: string): string => `m59 — ${label(id)}`;
    // The data model owns enumerations: m59 is planned first there, and kept.
    expect(section("data-model").dropped.length).toBeGreaterThan(0);
    expect(section("data-model").topics[0].title).toBe(title("data-model"));
    // Business rules owns constants, not this fact: m59 is ranked by relevance
    // alone there, last, and is the first module left out.
    expect(section("rules").dropped.map((t) => t.title)).toContain(title("rules"));
    // And the batches are written in that order: m59 is in the first.
    const moduleBudgets = tight.budgets.get("data-model")!;
    const priorities = tight.priorities.get("data-model")!;
    const group = GROUPS.find((g) => g.id === "data-model")!;
    const batches = planSectionBatches(
      withOwnedEnumerations(60, 59),
      group,
      100_000,
      16_384,
      60_000,
      {
        budgetChars: section("data-model").budgetChars,
        budgetOf: (m) =>
          [...moduleBudgets].find(([k]) => k.moduleName === m.moduleName)?.[1] ?? null,
        priorityOf: (m) => [...priorities].find(([k]) => k.moduleName === m.moduleName)?.[1] ?? 0,
      },
    );
    expect(batches.modules[0].item.moduleName).toBe("m59");
    expect(batches.modules.slice(1).map((m) => m.item.moduleName)).toEqual(
      [...batches.modules.slice(1)].map((m) => m.item.moduleName).sort(),
    );
  });

  it("names a module at the repository root", () => {
    const { plan: p } = plan([mod("", 4, { modulePath: "", moduleName: "" })]);
    expect(p.sections.find((s) => s.sectionId === "rules")!.topics[0].title).toBe(
      `(repository root) — ${RULES}`,
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

  it("treats a catalogue section as one call when batching is switched off, asking for the section cap", () => {
    vi.stubEnv("DOCS_GEN_BATCHED_SECTIONS", "off");
    const planning = plan(project(4));
    expect(planning.plan.sections.every((s) => s.kind === "single")).toBe(true);
    // What bounded such a section before the plan: the section cap, not the
    // 24,000 characters a section written in one call BY DESIGN asks for.
    expect(
      Object.fromEntries(planning.plan.sections.map((s) => [s.sectionId, s.demandChars])),
    ).toEqual({
      overview: SINGLE_CALL_SECTION_CHARS,
      capabilities: SINGLE_CALL_SECTION_CHARS,
      rules: 60_000,
      workflows: 60_000,
      formulas: 60_000,
      "data-model": 60_000,
      "integrations-and-glossary": SINGLE_CALL_SECTION_CHARS,
    });
    // 4 x 60,000 + 3 x 24,000 is more than the document: the catalogue
    // sections are levelled below what they ask — and still told no length.
    expect(planning.plan.sections.find((s) => s.sectionId === "rules")!.budgetChars).toBeLessThan(
      60_000,
    );
    // #1352 — the sections single-call by design are, though they were given
    // all they ask: an overrun of theirs comes out of the levelled sections.
    expect([...planning.lengthLimited].sort()).toEqual([
      "capabilities",
      "integrations-and-glossary",
      "overview",
    ]);
  });

  it("#1352 — tells a single-call section its length whenever the document's budget binds, given all it asks or not", () => {
    // Run B's shape: the catalogue sections levelled below the section cap,
    // every single-call section planned the 24,000 it asks.
    const planning = plan(project(60));
    const byId = new Map(planning.plan.sections.map((s) => [s.sectionId, s]));
    expect(byId.get("rules")!.budgetChars).toBeLessThan(byId.get("rules")!.demandChars);
    for (const id of ["overview", "capabilities", "integrations-and-glossary"]) {
      expect(byId.get(id)!.budgetChars).toBe(SINGLE_CALL_SECTION_CHARS);
      expect(planning.lengthLimited.has(id)).toBe(true);
    }
    // Never a catalogue section: it is held and asked for words per part.
    expect(planning.lengthLimited.has("rules")).toBe(false);
  });

  it("marks a single-call section as length-limited only when the document's budget binds", () => {
    expect([...plan(project(12)).lengthLimited]).toEqual([]);
    expect([...plan(project(12), 40_000).lengthLimited].sort()).toEqual([
      "capabilities",
      "integrations-and-glossary",
      "overview",
    ]);
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

  it("issues a single-call section no length limit while the document has room, and none ever with batching off", async () => {
    // The default caps and twelve small modules: nothing binds.
    const facts = project(12);
    const planned = fakeModel();
    await run(facts, planned);
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    const unplanned = fakeModel();
    await run(facts, unplanned);
    for (const id of ["overview", "capabilities", "integrations-and-glossary"]) {
      const [withPlan] = callsFor(planned, label(id));
      const [without] = callsFor(unplanned, label(id));
      expect(withPlan.user).not.toContain("LENGTH LIMIT");
      expect(withPlan.user).not.toContain("overrides");
      // The very prompt it had before there was a plan.
      expect(withPlan.user).toBe(without.user);
      expect(withPlan.system).toBe(without.system);
    }

    // Batching off, and a document too small for four sections of 60,000: the
    // catalogue sections, now written in one call each, keep the prompt they
    // had — "document every item" is not overridden by a plan budget.
    vi.stubEnv("DOCS_GEN_BATCHED_SECTIONS", "off");
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const offUnplanned = fakeModel();
    await run(facts, offUnplanned);
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "on");
    const offPlanned = fakeModel();
    await run(facts, offPlanned);
    for (const id of ["rules", "workflows", "formulas", "data-model"]) {
      const calls = callsFor(offPlanned, label(id));
      expect(calls).toHaveLength(1);
      expect(calls[0].user).not.toContain("LENGTH LIMIT");
      expect(calls[0].user).toBe(callsFor(offUnplanned, label(id))[0].user);
    }
    // The sections that are single-call by design are the ones given a limit here.
    expect(callsFor(offPlanned, label("overview"))[0].user).toContain("=== LENGTH LIMIT ===");
  });

  it("cuts nothing while the document fits its cap, however far a section ran past its budget", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const facts = project(12);
    // Rules is written three times its budget; every other section a third of its own.
    const provider = fakeModel({ overrun: (call) => (call.group === RULES ? 3 : 0.3) });
    const result = await run(facts, provider);
    const { plan } = planDocumentTopics({
      facts,
      groups: GROUPS,
      router: routerFor(fakeModel()),
      sectionMaxChars: 60_000,
      documentMaxChars: 40_000,
    });
    const budget = plan.sections.find((s) => s.sectionId === "rules")!.budgetChars;
    const rules = sectionOf(result.markdown, RULES);
    expect(rules.length).toBeGreaterThan(budget * 2);
    const body = result.markdown.slice(result.markdown.indexOf("\n## "));
    expect(body.length).toBeLessThan(40_000);
    // Under the cap: every paragraph every part wrote is in the document.
    expect(result.markdown).not.toContain("Shortened for length");
    expect(result.sections.every((s) => !s.omittedTopics)).toBe(true);
    for (const call of callsFor(provider, RULES)) {
      const words = Number(/write at most about (\d+) words/i.exec(call.user)![1]);
      const each = Math.max(120, Math.floor((words * 6 * 3) / call.modules.length));
      for (const m of call.modules) {
        expect(rules.split(`\n\n${m} rule `).length - 1, m).toBe(
          Math.max(1, Math.round(each / 150)),
        );
      }
    }
  });

  it("gives an overrunning section the room the sections AFTER it left unused", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const facts = project(12);
    // Rules is written eight times its budget — more than the document can
    // hold; the four sections written after it stay far under theirs.
    const provider = fakeModel({ overrun: (call) => (call.group === RULES ? 8 : 0.3) });
    const result = await run(facts, provider);
    const { plan } = planDocumentTopics({
      facts,
      groups: GROUPS,
      router: routerFor(fakeModel()),
      sectionMaxChars: 60_000,
      documentMaxChars: 40_000,
    });
    const budget = plan.sections.find((s) => s.sectionId === "rules")!.budgetChars;
    const rules = sectionOf(result.markdown, RULES);
    const others = GROUPS.filter((g) => g.label !== RULES).map((g) =>
      sectionOf(result.markdown, g.label),
    );
    // Only Rules is shortened, and it takes everything the others did not use:
    // the body ends within a paragraph or two of the cap.
    expect(rules).toContain("**Shortened for length.**");
    expect(rules).toContain(
      "The document is limited to about 40k characters (DOCS_GEN_DOCUMENT_MAX_CHARS).",
    );
    for (const other of others) expect(other).not.toContain("Shortened for length");
    expect(rules.length).toBeGreaterThan(budget * 3);
    const body = result.markdown.slice(result.markdown.indexOf("\n## "));
    expect(body.length).toBeLessThanOrEqual(40_000 + 400);
    expect(body.length).toBeGreaterThan(40_000 * 0.95);
    // What was cut is the END of each part: every part still leads with its first module.
    for (const call of callsFor(provider, RULES)) {
      expect(rules).toContain(`### About ${call.modules[0]}\n`);
    }
  });

  it("cuts each part in proportion to ITS planned budget when the document is over its cap", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "1000000000");
    const facts = project(12);
    // Every part of Rules writes the same 12,000 characters whatever it was
    // planned; the parts' budgets differ (the first reads the largest modules).
    const words = (call: Call): number =>
      Number(/write at most about (\d+) words/i.exec(call.user)![1]);
    const provider = fakeModel({
      overrun: (call) => (call.group === RULES ? 12_000 / (words(call) * 6) : 0.3),
    });
    const result = await run(facts, provider);
    const rules = sectionOf(result.markdown, RULES);
    expect(rules).toContain("**Shortened for length.**");
    const parts = callsFor(provider, RULES).map((call) => ({
      budget: words(call),
      kept: call.modules.reduce((n, m) => n + rules.split(`\n\n${m} rule `).length - 1, 0),
    }));
    expect(parts.length).toBeGreaterThan(2);
    const largest = parts.reduce((a, b) => (b.budget > a.budget ? b : a));
    const smallest = parts.reduce((a, b) => (b.budget < a.budget ? b : a));
    const planned = largest.budget / smallest.budget;
    expect(planned).toBeGreaterThan(1.3);
    // Every part wrote the same amount; what each KEPT follows its budget, to
    // within a paragraph or two (equal weights would keep the same of each).
    expect(smallest.kept).toBeGreaterThan(0);
    const kept = largest.kept / smallest.kept;
    expect(kept).toBeGreaterThan(1 + (planned - 1) * 0.6);
    expect(kept).toBeLessThan(planned * 1.3);
  });

  it("cuts each part's own tail under both caps: no part's leading topic is lost, where no plan loses whole parts", async () => {
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
    expect(rules).toContain("**Shortened for length.**");

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

  it("holds a section to the section cap as it RENDERS, its note included (#995)", async () => {
    // The default document cap leaves the section cap as the only limit that
    // binds. The model writes three times what each part is asked: far past
    // 20,000. Every paragraph cites a source: about 110 characters as drafted,
    // a short footnote reference as rendered.
    vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "20000");
    const marker = ` [facts:repo:${encodeURIComponent(JSON.stringify(["cmv1nna3w0001", "cmv1nnb0h0002", "src/m00"]))}:1]`;
    const provider = fakeModel({ overrun: 3, marker });
    const result = await run(project(12), provider);
    const rules = sectionOf(result.markdown, RULES).trim();
    expect(rules).not.toContain("facts:repo:");
    expect(rules).toContain(
      "This section is limited to about 20k characters (DOCS_GEN_SECTION_MAX_CHARS).",
    );
    // Within the cap, note and all — and full to it as rendered: a cap measured
    // on the draft would stop at about 12,000.
    expect(rules.length).toBeLessThanOrEqual(20_000);
    expect(rules.length).toBeGreaterThan(20_000 * 0.9);
    // Cut in plan order: every part still leads with its first module.
    for (const call of callsFor(provider, RULES)) {
      expect(rules).toContain(`### About ${call.modules[0]}\n`);
    }
    // The stored section is what was kept, with the parts of what was kept.
    const stored = result.sectionSynthesis!.records.find((r) => r.sectionId === "rules")!;
    expect(stored.markdown).toContain("**Shortened for length.**");
    expect(stored.parts!.runs.reduce((n, [, units]) => n + units, 0)).toBeGreaterThan(50);
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

  it("fact-checks every part as written, as without a plan, and lists a topic the cap left out", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    scoreFaithfulnessMock.mockResolvedValue(verified(1, 1));
    const grounding = {
      sources: [{ sourceId: "rag:doc:0", kind: "rag", label: "notes.md", text: "evidence" }],
      sourceIds: new Set(["rag:doc:0"]),
      isEmpty: false,
    } as unknown as GroundingContext;
    // One part of Rules answers with a single table larger than its budget.
    const provider = fakeModel({
      overrun: 8,
      table: (call) => call.group === RULES && call.modules.includes("m05"),
    });
    const result = await run(project(12), provider, { grounding });
    const tabled = callsFor(provider, RULES).find((c) => c.modules.includes("m05"))!;
    const rules = sectionOf(result.markdown, RULES);
    const entry = result.sections.find((s) => s.sectionLabel === RULES)!;
    const topic = `Table of ${tabled.modules[0]}`;
    // The table is whole in the section or its topic is listed: never half of it.
    expect(rules.includes("| limit 59 |") !== entry.omittedTopics!.includes(topic)).toBe(true);
    expect(rules.includes("| limit 0 |")).toBe(rules.includes("| limit 59 |"));
    // Nothing is discarded before the document is assembled, so every part is
    // judged whole — exactly the calls a document without a plan makes.
    const judged = scoreFaithfulnessMock.mock.calls
      .filter(([section]) => section === RULES)
      .map(([, markdown]) => markdown as string);
    expect(judged.length).toBe(callsFor(provider, RULES).length);
    expect(judged.some((markdown) => markdown.includes(topic))).toBe(true);
  });

  it("rewrites a planned section when its budget changes", async () => {
    // The same reuse key on purpose: the plan itself must be in the inputs.
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const facts = project(12);
    const first = await run(facts, fakeModel());
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "30000");
    const second = await run(facts, fakeModel(), { previous: first });
    expect(second.regeneration!.changed.sort()).toEqual(GROUPS.map((g) => g.id).sort());
  });

  it("cuts nothing and writes no note when the model keeps to its budgets", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const result = await run(project(12), fakeModel());
    expect(result.markdown).not.toContain("Shortened for length");
    expect(result.sections.every((s) => !s.omittedTopics)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("cuts a REUSED document exactly as it cut the written one: the parts travel with the section", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const facts = project(12);
    const model = () => fakeModel({ overrun: (call) => (call.group === RULES ? 8 : 0.3) });
    const first = await run(facts, model());
    const stored = first.sectionSynthesis!.records;
    // A section written in parts stores which part wrote what; one written in a call does not.
    const rules = stored.find((r) => r.sectionId === "rules")!;
    expect(rules.parts!.budgets.length).toBeGreaterThan(2);
    expect(rules.parts!.runs.length).toBeGreaterThanOrEqual(rules.parts!.budgets.length);
    expect(stored.find((r) => r.sectionId === "overview")!.parts).toBeUndefined();
    // What is stored is the section as written — nothing was discarded when it
    // was — and the document cap is applied again on every run.
    expect(rules.markdown).not.toContain("Shortened for length");
    const again = model();
    const second = await run(facts, again, { previous: first });
    expect(again.calls).toEqual([]);
    expect(second.markdown).toBe(first.markdown);
    expect(second.sections).toEqual(first.sections);
  });

  it("leaves out the lowest-priority modules at planning time, never reads them, and lists them", async () => {
    // One fixture past the topic floor: 60 modules cannot each have
    // MIN_TOPIC_CHARS of a section of a 30,000-character document within
    // the FLOOR_SHARE of it the floors may take.
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "30000");
    const facts = project(60);
    const provider = fakeModel();
    const result = await run(facts, provider);
    const read = new Set(callsFor(provider, RULES).flatMap((c) => c.modules));
    const sectionBudget = Math.floor((30_000 - 1_500) / GROUPS.length);
    expect(read.size).toBe(Math.floor((sectionBudget * FLOOR_SHARE) / MIN_TOPIC_CHARS));
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

  it("adds nothing to a prompt or to the notes when the plan is off, which is the default", async () => {
    // Byte-for-byte equality with the code before #1070 is held by
    // `holistic-synthesizer-topic-plan-off.test.ts`, against outputs that code produced.
    vi.unstubAllEnvs();
    vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "6000");
    vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "16384");
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const provider = fakeModel();
    const result = await run(project(12), provider);
    expect(result.sectionSynthesis!.records.every((r) => r.parts === undefined)).toBe(true);
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

  /**
   * `exportFormatName` is an enumeration value (owned by Data & Domain Model)
   * read from module `from`; m00's rules and m01's workflows mention it, and
   * nothing the data model reads does.
   */
  const withEnumeration = (count: number, from: number): ModuleFacts[] => {
    const facts = project(count);
    facts[0] = mod("m00", 2 * count, { rules: "- Exports are written as `exportFormatName`." });
    facts[1] = mod("m01", 2 * count - 1, {
      workflows: "- The export job names its file after `exportFormatName`.",
    });
    const name = `m${String(from).padStart(2, "0")}`;
    facts[from] = mod(name, 2 * count - from, {
      minedRules: [constant("exportFormatName", '"ndjson"')],
    });
    return facts;
  };
  const FACT_LINE =
    /\[facts:canon:cf-[0-9a-f]{10}\] exportFormatName = "ndjson" \| [^|]+ \| owner: (.+)/;

  it("always gives a fact to the section that owns it, in the part that reads its module", async () => {
    const provider = fakeModel();
    await run(withEnumeration(6, 3), provider);
    const dataModel = callsFor(provider, label("data-model"));
    // No ENTITIES slice mentions the name: before, the owner never heard of it.
    for (const call of dataModel) expect(call.user).not.toContain("`exportFormatName`");
    const told = dataModel.filter((c) => c.user.includes("CANONICAL FACTS"));
    expect(told).toHaveLength(1);
    expect(told[0].modules).toContain("m03");
    expect(FACT_LINE.exec(told[0].user)![1]).toBe("THIS section");
    expect(told[0].user).toContain("if you state it, state it once and completely");
    // The sections that mention it are told who owns it — a section that was told.
    const rules = callsFor(provider, RULES).find((c) => c.user.includes("CANONICAL FACTS"))!;
    expect(FACT_LINE.exec(rules.user)![1]).toBe(label("data-model"));
    expect(given(provider).sort()).toEqual(
      [label("capabilities"), RULES, label("workflows"), label("data-model")].sort(),
    );
  });

  it("names no owner, and issues no 'do not re-derive', for a fact whose owner cannot state it", async () => {
    // 60 modules in a 30,000-character document: the data model cannot plan
    // them all, nor all fifteen modules that hold a fact it owns: the module the
    // fact is read from (the lowest ranked of those) is left out.
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "30000");
    const provider = fakeModel();
    const result = await run(
      withOwnedEnumerations(
        60,
        59,
        Array.from({ length: 14 }, (_, k) => 45 + k),
      ),
      provider,
    );
    const entry = result.sections.find((s) => s.sectionLabel === label("data-model"))!;
    expect(entry.omittedTopics).toContain("m59 (not planned)");
    for (const call of callsFor(provider, label("data-model"))) {
      expect(call.modules).not.toContain("m59");
      expect(call.user).not.toContain("exportFormatName");
    }
    const told = provider.calls.filter((c) => FACT_LINE.test(c.user));
    expect(told.length).toBeGreaterThan(0);
    for (const call of told) {
      expect(FACT_LINE.exec(call.user)![1]).toBe("none");
      expect(call.user).toContain("A fact with NO owning section");
      // The rivals the data model reads are still its own; this fact is not.
      const line = call.user.split("\n").find((l) => FACT_LINE.test(l))!;
      expect(line).not.toContain(`owner: ${label("data-model")}`);
    }
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

  it("rewrites exactly those sections when the value changes LENGTH under a binding cap", async () => {
    // The variant the #1113 review showed failing: a cap small enough that the
    // sections' budgets are levelled, and a value one character longer. The
    // budgets are planned from the modules alone, so no other section moves.
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "20000");
    const first = await run(withLimit("100"), fakeModel());
    const { plan } = planDocumentTopics({
      facts: withLimit("100"),
      groups: GROUPS,
      router: routerFor(fakeModel()),
      sectionMaxChars: 60_000,
      documentMaxChars: 20_000,
    });
    // Binding: the catalogue sections are given less than they ask for.
    expect(plan.sections.find((s) => s.sectionId === "rules")!.budgetChars).toBeLessThan(
      plan.sections.find((s) => s.sectionId === "rules")!.demandChars,
    );
    const changed = fakeModel();
    const second = await run(withLimit("2000"), changed, { previous: first });
    expect(second.regeneration!.changed.sort()).toEqual(["capabilities", "rules", "workflows"]);
    expect([...new Set(changed.calls.map((c) => c.group))].sort()).toEqual(
      [label("capabilities"), RULES, label("workflows")].sort(),
    );
  });

  it("rewrites a section for a fact its input mentions beyond the forty one call lists", async () => {
    // 45 shared limits, all mentioned by m00's rules and m01's workflows.
    const names = Array.from({ length: 45 }, (_, i) => `sharedLimit${String(i).padStart(2, "0")}`);
    const mentions = names.map((n) => `- Bounded by \`${n}\`.`).join("\n");
    const withLimits = (last: string): ModuleFacts[] => {
      const facts = project(6);
      facts[0] = mod("m00", 12, {
        rules: mentions,
        minedRules: names.map((n, i) => ({
          ...constant(n, i === names.length - 1 ? last : String(i + 10)),
          line: i + 1,
        })),
      });
      facts[1] = mod("m01", 11, { workflows: mentions });
      return facts;
    };
    const provider = fakeModel();
    const first = await run(withLimits("54"), provider);
    // The call lists forty and counts the rest: the last-ranked fact is not shown.
    const shown = callsFor(provider, label("workflows")).find((c) =>
      c.user.includes("CANONICAL FACTS"),
    )!;
    expect(shown.user).toContain("(5 more canonical facts are not listed for this call.)");
    expect(shown.user).not.toContain("sharedLimit44 = ");
    const second = await run(withLimits("5400"), fakeModel(), { previous: first });
    expect(second.regeneration!.changed).toContain("workflows");
    expect(second.regeneration!.changed).not.toContain("formulas");
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
    const judged = scoreFaithfulnessMock.mock.calls.map((call) => ({
      section: call[0] as string,
      canonical: (call[2] as GroundingContext).sources.filter((s) =>
        s.sourceId.startsWith("facts:canon:"),
      ),
    }));
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
    const escalated = result.sections.find((s) => s.sectionLabel === RULES)!;
    expect(escalated.providerKind).toBe("anthropic");
    // The escalated section's own sources carry the fact it was given.
    expect(escalated.groundingSourceIds.some((id) => id.startsWith("facts:canon:"))).toBe(true);

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

  it("#1352 — asks a single-call section for its words at the overrun of the model that writes it, escalation included", async () => {
    vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "1");
    vi.stubEnv("DOCS_GEN_LOCAL_FACTS_CHAR_CAP", "6000");
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    // Measured for the local model only: the escalation model is asked as before.
    vi.stubEnv("DOCS_GEN_LENGTH_OVERRUN", "fake-section=2");
    const local = fakeModel({ inject: () => "[local] " }, "local-gemma");
    const cloud = fakeModel();
    (cloud as { model: string }).model = "cloud-escalation-model";
    const glossary = label("integrations-and-glossary");
    scoreFaithfulnessMock.mockImplementation(async (section: string, markdown: string) =>
      markdown.includes("[local]") && section === glossary ? verified(1, 10) : verified(10, 10),
    );
    await synthesizeFinalDocument(
      project(6),
      META,
      "business-requirements",
      "BRD",
      hybrid(local, cloud),
      "p1",
      {
        sources: [{ sourceId: "rag:doc:0", kind: "rag", label: "notes.md", text: "evidence" }],
        sourceIds: new Set(["rag:doc:0"]),
        isEmpty: false,
      } as unknown as GroundingContext,
    );
    const words = (call: Call): number =>
      Number(/Write at most about (\d+) words for this section group/.exec(call.user)![1]);
    const [drafted] = callsFor(local, glossary);
    const [escalated] = callsFor(cloud, glossary);
    // The same planned length, asked of the local model at half the words.
    expect(words(drafted) * 2).toBeGreaterThanOrEqual(words(escalated) - 50);
    expect(words(drafted) * 2).toBeLessThanOrEqual(words(escalated) + 50);
    expect(words(drafted)).toBeLessThan(words(escalated));
  });
});

describe("the consistency check in a planned document", () => {
  /** `maxPageSize = 100` is on the facts sheet; `POLLING_FREQUENCY` is not. */
  const facts = (): ModuleFacts[] => {
    const all = project(6);
    all[0] = mod("m00", 12, {
      rules: "- A page never holds more than `maxPageSize` entries.",
      minedRules: [constant("maxPageSize", "100")],
    });
    all[1] = mod("m01", 11, {
      workflows: "- Listing stops after `maxPageSize` entries and returns a cursor.",
    });
    return all;
  };
  const WRONG = "`maxPageSize` (default 250). ";
  const STATES = [
    "`POLLING_FREQUENCY` (default 60 min). ",
    "`POLLING_FREQUENCY` (default 30 min). ",
  ];
  const disagree = (call: Call): string =>
    call.group === label("overview")
      ? `${WRONG}${STATES[0]}`
      : call.group === label("integrations-and-glossary")
        ? STATES[1]
        : "";

  it("notes a sheet value stated differently, not a name the sheet does not hold, and changes nothing", async () => {
    const result = await run(facts(), fakeModel({ inject: disagree }));
    const notes = result.warnings.filter((w) => w.kind === "fact-inconsistent");
    expect(notes).toHaveLength(1);
    expect(notes[0].severity).toBe("info");
    expect(notes[0].message).toContain(
      "Consistency check: 1 value stated differently from the source.",
    );
    expect(notes[0].message).toContain(
      "`maxPageSize` is stated with a value that is not the source's (`250` in Overview & Domain). The source has `100` at src/m00/limits.go:12.",
    );
    // Two values of a name the sheet does not hold are not judged.
    expect(notes[0].message).not.toContain("POLLING_FREQUENCY");
    // A note, not a degradation; and the document carries no mark of it.
    expect(deriveDocStatus(result.warnings)).toBe("ready");
    expect(result.markdown).not.toContain("Consistency check");
    const quiet = await run(facts(), fakeModel());
    expect(quiet.warnings).toEqual([]);
    const strip = (md: string) =>
      [WRONG, ...STATES].reduce((text, inserted) => text.replaceAll(inserted, ""), md);
    expect(strip(result.markdown)).toBe(quiet.markdown);
  });

  it("reports the same thing when every section is reused", async () => {
    const first = await run(facts(), fakeModel({ inject: disagree }));
    expect(first.warnings.map((w) => w.kind)).toEqual(["fact-inconsistent"]);
    const again = fakeModel();
    const second = await run(facts(), again, { previous: first });
    expect(again.calls).toEqual([]);
    expect(second.warnings).toEqual(first.warnings);
  });

  it("does not run without the plan", async () => {
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    const result = await run(facts(), fakeModel({ inject: disagree }));
    expect(result.warnings).toEqual([]);
    // And nothing of a plan is recorded for provenance.
    expect(result).not.toHaveProperty("topicPlan");
    expect(result).not.toHaveProperty("consistency");
  });

  it("records the plan and the check for provenance, a clean check included (#1070)", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "30000");
    const result = await run(project(60), fakeModel());
    // Nothing found: no note on the document, but the answer is recorded.
    expect(result.warnings.some((w) => w.kind === "fact-inconsistent")).toBe(false);
    expect(result.consistency).toEqual({
      statements: expect.any(Number),
      compared: expect.any(Number),
      findingCount: 0,
      findings: [],
    });
    const plan = result.topicPlan!;
    expect(plan.sections.map((s) => s.sectionLabel)).toEqual(GROUPS.map((g) => g.label));
    const rules = plan.sections.find((s) => s.sectionLabel === RULES)!;
    expect(rules.kind).toBe("enumerative");
    expect(rules.plannedTopics + rules.dropped.length).toBe(60);
    // Left out at planning time, most important first: m59 is the last.
    expect(rules.dropped.length).toBeGreaterThan(0);
    expect(rules.dropped.at(-1)).toBe(`m59 — ${RULES}`);
    expect(plan.budgetChars).toBe(
      plan.unallocatedChars + plan.sections.reduce((n, s) => n + s.budgetChars, 0),
    );
    // The same topics are listed with the section's omissions.
    const entry = result.sections.find((s) => s.sectionLabel === RULES)!;
    expect(entry.omittedTopics).toContain("m59 (not planned)");
  });

  it("notes two sections that count one kind of thing differently (#1070, run 8)", async () => {
    const provider = fakeModel({
      inject: (call) =>
        call.group === label("overview")
          ? "Access is governed by five distinct authentication mechanisms. "
          : call.group === label("integrations-and-glossary")
            ? "It supports four independent authentication paths. "
            : "",
    });
    const result = await run(facts(), provider);
    const notes = result.warnings.filter((w) => w.kind === "fact-inconsistent");
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain(
      "The number of `authentication mechanisms` is given 2 different ways in 2 sections",
    );
    expect(result.consistency).toEqual(
      expect.objectContaining({
        findingCount: 1,
        findings: [
          expect.objectContaining({
            kind: "count",
            name: "authentication ways",
            label: "authentication mechanisms",
            statements: [
              { section: label("overview"), value: "five distinct authentication mechanisms" },
              {
                section: label("integrations-and-glossary"),
                value: "four independent authentication paths",
              },
            ],
          }),
        ],
      }),
    );
    expect(deriveDocStatus(result.warnings)).toBe("ready");
  });

  it("#1119 — quotes only statements that are in the document: not one the length fit removed", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    // Overview states a wrong value in its first paragraph, which stays. Every
    // part of Rules runs to eight times its budget and states another wrong
    // value in its LAST paragraph, which the document fit removes.
    const CUT = "`maxPageSize` (default 999). ";
    const provider = fakeModel({
      overrun: (call) => (call.group === RULES ? 8 : 0.3),
      inject: (call) => (call.group === label("overview") ? WRONG : ""),
      injectLast: (call) => (call.group === RULES ? CUT : ""),
    });
    const result = await run(facts(), provider);
    // The model wrote it, in every part of Rules, and the fit took every one.
    expect(callsFor(provider, RULES).length).toBeGreaterThan(0);
    for (const call of callsFor(provider, RULES)) expect(call.user).toContain("write at most");
    expect(sectionOf(result.markdown, RULES)).toContain("**Shortened for length.**");
    expect(result.markdown).not.toContain("default 999");
    expect(result.markdown).toContain("default 250");
    const notes = result.warnings.filter((w) => w.kind === "fact-inconsistent");
    expect(notes).toHaveLength(1);
    expect(notes[0].message).toContain("(`250` in Overview & Domain)");
    expect(notes[0].message).not.toContain("999");
    expect(notes[0].message).not.toContain(RULES);
    // Reused, the same sections are fitted the same way and say the same thing.
    const again = fakeModel();
    const second = await run(facts(), again, { previous: result });
    expect(again.calls).toEqual([]);
    expect(second.warnings).toEqual(result.warnings);
  });
});

describe("#1119 — what a planned run logs of each section's fit", () => {
  interface FitLog {
    message: string;
    cut: string;
    documentMaxChars: number;
    bodyMaxChars: number;
    unplannedWithinCap: boolean;
    sections: Array<{
      section: string;
      cut: string;
      keptChars: number;
      planKeptChars: number;
      unplannedKeptChars: number;
    }>;
  }
  const FIT = "Planned document fit by section";
  /** Every entry the synthesizer logged during `work`, as the logger was given it. */
  async function logged(work: () => Promise<unknown>): Promise<Array<Record<string, unknown>>> {
    const write = vi.spyOn(logger, "write");
    try {
      await work();
      return write.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    } finally {
      write.mockRestore();
    }
  }
  const fitLogs = (entries: Array<Record<string, unknown>>): FitLog[] =>
    (entries.filter((entry) => entry.message === FIT) as unknown as FitLog[]).map(
      ({ message, cut, documentMaxChars, bodyMaxChars, unplannedWithinCap, sections }) => ({
        message,
        cut,
        documentMaxChars,
        bodyMaxChars,
        unplannedWithinCap,
        sections,
      }),
    );

  it("logs every section's kept characters when the document is cut, with what no plan would have kept", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "1000000000");
    const provider = fakeModel({ overrun: (call) => (call.group === RULES ? 8 : 0.3) });
    let result!: Result;
    const entries = await logged(async () => {
      result = await run(project(12), provider);
    });
    const logs = fitLogs(entries);
    expect(logs).toHaveLength(1);
    const [fit] = logs;
    expect(fit.documentMaxChars).toBe(40_000);
    expect(fit.bodyMaxChars).toBeLessThanOrEqual(40_000);
    expect(fit.cut).toBe("plan");
    expect(fit.unplannedWithinCap).toBe(true);
    expect(fit.sections.map((s) => s.section)).toEqual(GROUPS.map((g) => g.id));
    for (const section of fit.sections) {
      // Only Rules is over; the others are whole under either cut.
      const cut = section.section === "rules";
      expect(section.cut, section.section).toBe(cut ? "plan" : "whole");
      expect(section.planKeptChars).toBe(section.keptChars);
      for (const figure of [section.keptChars, section.unplannedKeptChars]) {
        expect(Number.isInteger(figure) && figure > 0).toBe(true);
      }
      if (!cut) expect(section.unplannedKeptChars).toBe(section.keptChars);
      // What the section kept is what is in the document (its note aside; the
      // last section runs into the footer, so it is not measured this way).
      if (section.section === GROUPS[GROUPS.length - 1].id) continue;
      const inDocument = sectionOf(result.markdown, label(section.section)).trimEnd();
      const body = inDocument.split("\n\n> **Shortened for length.**")[0];
      expect(Math.abs(body.length - section.keptChars), section.section).toBeLessThan(8);
    }
    // The guarantee: the document keeps no less than without a plan.
    const total = (key: "keptChars" | "unplannedKeptChars"): number =>
      fit.sections.reduce((n, s) => n + s[key], 0);
    expect(total("keptChars")).toBeGreaterThanOrEqual(total("unplannedKeptChars"));
    // Structured, and none of the model's text: ids and numbers only.
    const text = JSON.stringify(fit);
    expect(text).not.toContain("rule 0");
    expect(text).not.toContain("This policy applies");
    for (const section of fit.sections) {
      expect(Object.keys(section).sort()).toEqual(
        ["cut", "keptChars", "planKeptChars", "section", "unplannedKeptChars"].sort(),
      );
    }
  });

  it("logs, for a section shortened at the SECTION cap, what the plan and no plan kept of it as written", async () => {
    // The default document cap leaves the section cap as the only limit that
    // binds, so the document fit sees Rules already shortened and reports it
    // whole: the loss is visible only on the section's own line.
    vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "20000");
    const provider = fakeModel({ overrun: 3 });
    let result!: Result;
    const entries = await logged(async () => {
      result = await run(project(12), provider);
    });
    expect(sectionOf(result.markdown, RULES)).toContain(
      "This section is limited to about 20k characters (DOCS_GEN_SECTION_MAX_CHARS).",
    );
    const capped = entries.filter((entry) => entry.message === "Planned section over its cap");
    const rules = capped.find((entry) => entry.group === "rules") as
      | { cut: string; keptChars: number; planKeptChars: number; unplannedKeptChars: number }
      | undefined;
    expect(rules).toBeDefined();
    expect(rules!.cut).toBe("plan");
    for (const figure of [rules!.keptChars, rules!.planKeptChars, rules!.unplannedKeptChars]) {
      expect(Number.isInteger(figure) && figure > 0).toBe(true);
    }
    // The plan-ordered cut is the one used, and it keeps no less than no plan.
    expect(rules!.planKeptChars).toBe(rules!.keptChars);
    expect(rules!.keptChars).toBeGreaterThan(rules!.unplannedKeptChars);
    expect(rules!.keptChars).toBeLessThanOrEqual(20_000);
    // What it kept is what the document carries of the section, its note aside.
    const body = sectionOf(result.markdown, RULES)
      .trimEnd()
      .split("\n\n> **Shortened for length.**")[0];
    expect(Math.abs(body.length - rules!.keptChars)).toBeLessThan(8);
    // The document fit, measured after this cut, reports the section whole:
    // without the section's own figures the shortening would not be in the log.
    const [fit] = fitLogs(entries);
    const inDocument = fit.sections.find((s) => s.section === "rules")!;
    expect(inDocument.cut).toBe("whole");
    expect(inDocument.unplannedKeptChars).toBe(inDocument.keptChars);
    expect(inDocument.unplannedKeptChars).toBeGreaterThan(rules!.unplannedKeptChars);
    // Ids and numbers only: no text of the section.
    for (const entry of capped) {
      // The logger's own envelope, the project and group ids, and the figures.
      expect(Object.keys(entry).sort()).toEqual(
        [
          "cut",
          "group",
          "keptChars",
          "level",
          "message",
          "module",
          "planKeptChars",
          "projectId",
          "service",
          "timestamp",
          "unplannedKeptChars",
        ].sort(),
      );
      const text = JSON.stringify(entry);
      expect(text).not.toContain("rule 0");
      expect(text).not.toContain("This policy applies");
      expect(text).not.toContain("About ");
    }
  });

  it("logs it on a planned run that cuts nothing, and on one that reuses every section", async () => {
    const facts = project(6);
    let first!: Result;
    const written = fitLogs(
      await logged(async () => {
        first = await run(facts, fakeModel());
      }),
    );
    expect(written).toHaveLength(1);
    expect(written[0].cut).toBe("whole");
    expect(first.markdown).not.toContain("Shortened for length");
    for (const section of written[0].sections) {
      expect(section.cut).toBe("whole");
      expect(section.planKeptChars).toBe(section.keptChars);
      expect(section.unplannedKeptChars).toBe(section.keptChars);
    }
    const again = fakeModel();
    const reused = fitLogs(await logged(() => run(facts, again, { previous: first })));
    expect(again.calls).toEqual([]);
    expect(reused).toEqual(written);
  });

  it("logs nothing of the kind without the plan, or for a document type that is never planned", async () => {
    const architecture = await logged(() =>
      run(project(6), fakeModel(), { docType: "architecture" }),
    );
    expect(fitLogs(architecture)).toEqual([]);
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
    const off = await logged(() => run(project(12), fakeModel({ perModule: 3_000 })));
    expect(fitLogs(off)).toEqual([]);
    // The unplanned cut still logs what it always did.
    expect(
      off.some((entry) => String(entry.message).startsWith("Document over its length cap")),
    ).toBe(true);
  });
});
