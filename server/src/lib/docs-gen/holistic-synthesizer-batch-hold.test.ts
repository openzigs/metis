/**
 * #1327 — each batch of a planned catalogue section is held to its planned
 * share when it is written, and asked for its words corrected by the model's
 * measured overrun. Through `synthesizeFinalDocument`, with a fake model that
 * REGROUPS its modules the way DeepSeek does: it writes one thematic topic
 * per module, the batch's most important module LAST, cites each topic's
 * module, and writes a fixed multiple of the words it is asked for. No
 * network, no database, no live model.
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
import type { FaithfulnessResult } from "./grounding/citation-validator.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2ProviderBundle,
  type Phase2Router,
} from "./holistic-synthesizer.js";

const bullets = (kind: string, name: string, n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `- ${kind} ${i} of ${name}: the request is checked against the configured policy.`,
  ).join("\n");

function mod(name: string, size: number): ModuleFacts {
  const facts = [
    "PURPOSE",
    `${name} handles one business capability.`,
    "RULES",
    bullets("rule", name, size),
    "WORKFLOWS",
    bullets("step", name, size),
    "FORMULAS",
    bullets("formula", name, Math.max(1, size >> 1)),
    "ENTITIES",
    bullets("entity", name, Math.max(1, size >> 1)),
    "INTEGRATIONS",
    bullets("integration", name, 1),
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
  };
}

/** `count` modules, larger first, so the plan's priority order is m00, m01, … */
const project = (count: number): ModuleFacts[] =>
  Array.from({ length: count }, (_, i) => mod(`m${String(i).padStart(2, "0")}`, 2 * count - i));

interface Call {
  group: string;
  modules: string[];
  words: number | null;
  /** One part of a catalogue section. */
  batched: boolean;
  user: string;
}

const PARAGRAPH = "This policy applies to every request the capability receives today. ";

/**
 * Writes `overrun` times the words its prompt asks for, one topic per module
 * named "Theme of <module>", in REVERSE order of the facts (the batch's most
 * important module last), every paragraph citing that module's facts source.
 */
function regroupingModel(overrun: number | ((call: Call) => number), model = "fake-section-model") {
  const calls: Call[] = [];
  const reply = (call: Call): string => {
    const ids = new Map(
      [...call.user.matchAll(/\[SOURCE id=(facts:\S+) kind=facts label="([^"]+)"\]/g)].map((m) => [
        m[2],
        m[1],
      ]),
    );
    const modules = call.modules.length > 0 ? call.modules : ["everything"];
    const factor = typeof overrun === "function" ? overrun(call) : overrun;
    const total = call.words !== null ? call.words * 6 * factor : 400 * modules.length;
    const each = Math.max(150, Math.floor(total / modules.length));
    const paragraphs = Math.max(1, Math.round(each / 150));
    const topics = [...modules].reverse().map((m) =>
      [
        `### Theme of ${m}`,
        ...Array.from(
          { length: paragraphs },
          // About 150 characters as rendered, the citation a short footnote.
          (_, p) => `${m} rule ${p}. ${PARAGRAPH.repeat(2)}${ids.has(m) ? ` [${ids.get(m)}]` : ""}`,
        ),
      ].join("\n\n"),
    );
    return `## ${call.group}\n\n${topics.join("\n\n")}`;
  };
  const provider = {
    key: "anthropic",
    model,
    offline: false,
    calls,
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      const facts = user.slice(
        user.indexOf("=== EXTRACTED MODULE FACTS ==="),
        user.indexOf("=== END MODULE FACTS ==="),
      );
      const limit = /write at most about (\d+) words/i.exec(user);
      const call: Call = {
        group: /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?",
        modules: [...new Set([...facts.matchAll(/^### MODULE: (\S+)/gm)].map((m) => m[1]))],
        words: limit ? Number(limit[1]) : null,
        batched: user.includes("=== BATCH INSTRUCTIONS ==="),
        user,
      };
      calls.push(call);
      yield { type: "delta", content: reply(call) };
      yield { type: "done", finishReason: "stop" };
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
const RULES = GROUPS.find((g) => g.id === "rules")!.label;

const GROUNDING = {
  sources: [{ sourceId: "rag:doc:0", kind: "rag", label: "notes.md", text: "evidence" }],
  sourceIds: new Set(["rag:doc:0"]),
  isEmpty: false,
} as unknown as GroundingContext;

const verified: FaithfulnessResult = {
  section: "s",
  totalClaims: 1,
  supportedClaims: 1,
  faithfulness: 1,
  verified: true,
  unsupportedClaims: [],
  supportedAttributions: [],
};

type Result = Awaited<ReturnType<typeof synthesizeFinalDocument>>;

function run(facts: ModuleFacts[], provider: AIProvider, previous?: Result): Promise<Result> {
  return synthesizeFinalDocument(
    facts,
    META,
    "business-requirements",
    "BRD",
    routerFor(provider),
    "p1",
    GROUNDING,
    undefined,
    undefined,
    undefined,
    {
      effectiveConfigHash: "cfg",
      ...(previous
        ? { previousManifest: { sectionSynthesis: previous.sectionSynthesis } as never }
        : {}),
    },
  );
}

function sectionOf(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const next = markdown.indexOf("\n## ", start + 3);
  return markdown.slice(start, next < 0 ? undefined : next);
}

const rulesCalls = (p: { calls: Call[] }): Call[] => p.calls.filter((c) => c.group === RULES);
const has = (section: string, module: string): boolean =>
  section.includes(`### Theme of ${module}\n`);
/** The topics each batch wrote that are not in `section`: batch index and module. */
const lostTopics = (section: string, calls: Call[]): Array<{ b: number; m: string }> =>
  calls.flatMap((call, b) => call.modules.filter((m) => !has(section, m)).map((m) => ({ b, m })));

beforeEach(() => {
  scoreFaithfulnessMock.mockReset();
  scoreFaithfulnessMock.mockResolvedValue(verified);
  vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "6000");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "100000");
  vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "on");
  vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "40000");
});
afterEach(() => vi.unstubAllEnvs());

describe("#1327 — a planned batch held to its share when it is written", () => {
  it("keeps every batch's most important topic when the model writes it last and overruns 1.4x", async () => {
    const provider = regroupingModel(1.4);
    const result = await run(project(12), provider);
    const rules = sectionOf(result.markdown, RULES);
    const calls = rulesCalls(provider);
    expect(calls.length).toBeGreaterThan(2);
    // The document cap binds: something was given up.
    expect(rules).toContain("**Shortened for length.**");
    // Each batch wrote its most important module LAST, so a cut of each
    // part's tail as written would take exactly that topic. Held, it stays.
    for (const call of calls) expect(has(rules, call.modules[0])).toBe(true);
    // What a part gave up is its least important topics: within a batch, a
    // topic is present only if every more important one is.
    for (const call of calls) {
      const present = call.modules.map((m) => has(rules, m));
      expect(present).toEqual([...present].sort((a, b) => Number(b) - Number(a)));
    }
    // And every topic is either in the section or listed as left out.
    const entry = result.sections.find((s) => s.sectionLabel === RULES)!;
    for (const call of calls) {
      for (const m of call.modules) {
        expect(has(rules, m) || entry.omittedTopics!.includes(`Theme of ${m}`)).toBe(true);
      }
    }
  });

  it("loses only the last batch's lowest-priority topics when only that batch overruns 1.4x", async () => {
    // Every other call keeps to the words it is asked for.
    const lastOf = (call: Call): boolean => call.group === RULES && call.modules.includes("m11");
    const provider = regroupingModel((call) => (lastOf(call) ? 1.4 : 1));
    const result = await run(project(12), provider);
    const rules = sectionOf(result.markdown, RULES);
    const calls = rulesCalls(provider);
    expect(calls.length).toBeGreaterThan(2);
    expect(lastOf(calls[calls.length - 1])).toBe(true);
    const lost = lostTopics(rules, calls);
    expect(lost.length).toBeGreaterThan(0);
    // Every batch but the last keeps every topic it wrote: one batch's
    // overrun never costs another batch its text.
    expect(lost.every(({ b }) => b === calls.length - 1)).toBe(true);
    // And what the last batch lost is its lowest-priority modules, though it
    // wrote them FIRST.
    const last = calls[calls.length - 1].modules;
    expect(lost.map(({ m }) => m)).toEqual(last.slice(last.length - lost.length));
  });

  it("loses fewer topics, each a batch's least important, when a 1.4x overrun is calibrated", async () => {
    const batchesOverrun = (call: Call): number => (call.batched ? 1.4 : 1);
    const uncalibrated = regroupingModel(batchesOverrun);
    const before = lostTopics(
      sectionOf((await run(project(12), uncalibrated)).markdown, RULES),
      rulesCalls(uncalibrated),
    );
    vi.stubEnv("DOCS_GEN_LENGTH_OVERRUN", "fake-section=1.4");
    const calibrated = regroupingModel(batchesOverrun);
    const rules = sectionOf((await run(project(12), calibrated)).markdown, RULES);
    const calls = rulesCalls(calibrated);
    expect(calls.length).toBeGreaterThan(2);
    const after = lostTopics(rules, calls);
    expect(before.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(before.length);
    // Whatever a batch lost is the end of its priority order.
    calls.forEach((call, b) => {
      const gone = after.filter((t) => t.b === b).map((t) => t.m);
      expect(gone).toEqual(call.modules.slice(call.modules.length - gone.length));
    });
  });

  it("asks a model with a measured overrun for its share divided by it, and any other for its share", async () => {
    const plain = regroupingModel(1);
    await run(project(12), plain);
    vi.stubEnv("DOCS_GEN_LENGTH_OVERRUN", "fake-section=1.4");
    const calibrated = regroupingModel(1);
    await run(project(12), calibrated);
    const asked = (p: { calls: Call[] }) => rulesCalls(p).map((c) => c.words!);
    expect(asked(plain).length).toBe(asked(calibrated).length);
    asked(plain).forEach((words, i) => {
      // Both are rounded to 50 words (batchWordBudget), so they differ from
      // an exact 1/1.4 by at most 25 + 25 / 1.4.
      expect(Math.abs(asked(calibrated)[i] - words / 1.4)).toBeLessThanOrEqual(25 + 25 / 1.4);
      expect(asked(calibrated)[i]).toBeLessThan(words);
    });
    // The per-module shares and the section's words are divided too.
    const shares = (call: Call) =>
      /PLANNED SHARE of that limit by module \(approximate words\): ([^.]+)\./.exec(call.user)![1];
    expect(shares(rulesCalls(calibrated)[0])).not.toBe(shares(rulesCalls(plain)[0]));
    const section = (call: Call) =>
      Number(/the whole section is limited to about (\d+) words/.exec(call.user)![1]);
    expect(section(rulesCalls(calibrated)[0])).toBeLessThan(section(rulesCalls(plain)[0]));
  });

  it("moves nothing in a batch that is told no length: the plan's budget does not bind it", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "1000000");
    vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "1000000000");
    // A 1,000,000-character document plans every module what it asks: no
    // batch is told a length, so none is held.
    const provider = regroupingModel(3);
    const result = await run(project(12), provider);
    const rules = sectionOf(result.markdown, RULES);
    expect(rulesCalls(provider).length).toBeGreaterThan(0);
    expect(rulesCalls(provider).every((call) => call.words === null)).toBe(true);
    for (const call of rulesCalls(provider)) {
      // As written: the batch's modules in reverse order.
      const at = call.modules.map((m) => rules.indexOf(`### Theme of ${m}\n`));
      expect(at.every((i) => i >= 0)).toBe(true);
      expect(at).toEqual([...at].sort((a, b) => b - a));
    }
    expect(rules).not.toContain("Shortened for length");
  });

  it("removes nothing when the shares bind but the document fits: an overrunning batch is only reordered", async () => {
    // The plan's budget binds (every batch is told a length), one batch of
    // Rules writes 1.6 times its share and every other call half of its own,
    // so the document as a whole is under its cap.
    const first = (call: Call): boolean => call.group === RULES && call.modules.includes("m00");
    const provider = regroupingModel((call) => (first(call) ? 1.6 : 0.5));
    const result = await run(project(12), provider);
    const calls = rulesCalls(provider);
    expect(calls.every((call) => call.words !== null)).toBe(true);
    expect(result.markdown).not.toContain("Shortened for length");
    const rules = sectionOf(result.markdown, RULES);
    // Every topic every batch wrote is in the document.
    expect(lostTopics(rules, calls)).toEqual([]);
    // The overrunning batch was written least important first; it now leads
    // with its most important module, its overflow after.
    const lead = calls.find(first)!;
    const at = lead.modules.map((m) => rules.indexOf(`### Theme of ${m}\n`));
    expect(at[0]).toBeLessThan(at[at.length - 1]);
  });

  it("logs the overrun factor, the rendered reply length and the topics put past their shares", async () => {
    const write = vi.spyOn(logger, "write");
    try {
      vi.stubEnv("DOCS_GEN_LENGTH_OVERRUN", "fake-section=1.2");
      await run(project(12), regroupingModel(1.4));
      const entry = write.mock.calls
        .map(([logged]) => logged as unknown as Record<string, unknown>)
        .find(
          (logged) => logged.message === "Batched section synthesized" && logged.group === "rules",
        ) as Record<string, number>;
      expect(entry.lengthOverrun).toBe(1.2);
      expect(entry.renderedReplyChars).toBeGreaterThan(0);
      expect(entry.renderedReplyChars).toBeLessThan(entry.replyChars);
      expect(entry.reorderedParts).toBeGreaterThan(0);
      expect(entry.overflowTopics).toBeGreaterThan(0);
    } finally {
      write.mockRestore();
    }
  });

  it("rewrites the catalogue sections, and only those, when the overrun factor changes", async () => {
    const facts = project(12);
    const first = await run(facts, regroupingModel(1));
    const again = await run(facts, regroupingModel(1), first);
    expect(again.regeneration!.changed).toEqual([]);
    vi.stubEnv("DOCS_GEN_LENGTH_OVERRUN", "fake-section=1.4");
    const second = await run(facts, regroupingModel(1), first);
    expect(second.regeneration!.changed.sort()).toEqual(
      ["data-model", "formulas", "rules", "workflows"].sort(),
    );
  });

  it("rewrites nothing when the factor changes for a document whose sections are told no length", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "1000000");
    vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "1000000000");
    const facts = project(12);
    const provider = regroupingModel(1);
    const first = await run(facts, provider);
    expect(rulesCalls(provider).every((call) => call.words === null)).toBe(true);
    vi.stubEnv("DOCS_GEN_LENGTH_OVERRUN", "fake-section=1.4");
    const second = await run(facts, regroupingModel(1), first);
    expect(second.regeneration!.changed).toEqual([]);
  });
});
