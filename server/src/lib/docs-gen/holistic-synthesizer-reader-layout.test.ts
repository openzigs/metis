/**
 * #1175 — a business-requirements document in the reader layout
 * (`DOCS_GEN_BRD_LAYOUT=reader`), through `sectionGroupsFor`,
 * `planDocumentTopics` and `synthesizeFinalDocument`: a main document for a
 * business reader held to its length, then an appendix with the
 * module-by-module detail, in the same document. The fake model writes one H3
 * topic per module it is given and can be told to overrun the length its
 * prompt states. No network, no database, no live model.
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
import { RECONSTRUCTION_FAITHFULNESS_THRESHOLD } from "./grounding/degraded-warnings.js";
import {
  APPENDIX_DIVIDER,
  REQUIREMENTS_LEAD_IN,
  BRD_MAIN_MAX_CHARS,
  BRD_MAIN_SECTION_TARGETS,
  BRD_MAIN_TARGET_CHARS,
} from "./brd-layout.js";
import { batchWordBudget } from "./section-size.js";
import {
  brdReaderLayoutEnabled,
  docsGenTuning,
  planDocumentTopics,
  sectionGroupsFor,
  synthesizeFinalDocument,
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

const META = {
  name: "Fixture",
  totalFiles: 40,
  totalSymbols: 900,
  language: "go",
} as never;
const CATALOGUE = sectionGroupsFor("business-requirements");
const READER = sectionGroupsFor("business-requirements", {
  brdLayout: "reader",
});
const label = (id: string): string => READER.find((g) => g.id === id)!.label;
const MAIN_IDS = Object.keys(BRD_MAIN_SECTION_TARGETS);
const MAIN_LABELS = MAIN_IDS.map(label);
const APPENDIX_IDS = ["rules", "workflows", "formulas", "data-model", "integrations-and-glossary"];

type Result = Awaited<ReturnType<typeof synthesizeFinalDocument>>;

async function run(facts: ModuleFacts[], provider: AIProvider): Promise<Result> {
  return synthesizeFinalDocument(
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
    { effectiveConfigHash: "cfg" },
  );
}

/** The markdown of one H2 section of an assembled document, up to the next H1 or H2. */
function sectionOf(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  if (start < 0) return "";
  const end = markdown.slice(start + 3).search(/\n#{1,2} /);
  return markdown.slice(start, end < 0 ? undefined : start + 3 + end);
}

/** The main part of an assembled reader-layout document: its sections before the divider. */
function mainPartOf(markdown: string): string {
  const at = markdown.indexOf(APPENDIX_DIVIDER);
  return markdown.slice(markdown.indexOf("\n## ") + 1, at < 0 ? undefined : at).trim();
}

const callsFor = (p: { calls: Call[] }, group: string): Call[] =>
  p.calls.filter((c) => c.group === group);

beforeEach(() => {
  scoreFaithfulnessMock.mockReset();
  vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "6000");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "100000");
  vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "reader");
});
afterEach(() => vi.unstubAllEnvs());

// ── Tests ─────────────────────────────────────────────────────────────────

describe("the reader layout's sections", () => {
  it("is a main document then the catalogue sections, unchanged, as its appendix", () => {
    expect(READER.map((g) => g.id)).toEqual([...MAIN_IDS, ...APPENDIX_IDS]);
    // The appendix is the catalogue layout's own sections, unchanged.
    // (#1223 — the capabilities keep their gating but ask for business language.)
    for (const id of APPENDIX_IDS) {
      expect(READER.find((g) => g.id === id)).toEqual(CATALOGUE.find((g) => g.id === id));
    }
    expect(MAIN_LABELS).toEqual([
      "Executive Summary, Scope & Domain",
      "Core Business Capabilities",
      "Key Business Rules",
      "Requirements Reconstructed from the Code",
    ]);
  });

  it("asks the opening for an executive summary and a scope, for a business reader", () => {
    const overview = READER.find((g) => g.id === "overview")!;
    for (const text of [
      "## Executive Summary",
      "## Scope",
      "**In scope**",
      "**Out of scope**",
      "## Business Domain Overview",
      "business language",
    ]) {
      expect(overview.instructions).toContain(text);
    }
    // Gated as the catalogue layout's overview is.
    const before = CATALOGUE.find((g) => g.id === "overview")!;
    expect(overview.narrative).toBe(before.narrative);
    expect(overview.faithfulnessThreshold).toBe(before.faithfulnessThreshold);
    expect(overview.factSlices).toEqual(before.factSlices);
  });

  it("asks for requirements reconstructed from the code, never presented as the approved ones", () => {
    const requirements = READER.find((g) => g.id === "requirements")!;
    expect(requirements.label).toBe("Requirements Reconstructed from the Code");
    expect(requirements.instructions).toContain("## Requirements Reconstructed from the Code");
    expect(requirements.instructions).toContain("### RC-<n>: <short title>");
    expect(requirements.instructions).not.toContain("BR-<n>");
    expect(requirements.instructions).toContain("**Acceptance criteria:**");
    expect(requirements.instructions).toContain("NOT one per module");
    expect(requirements.instructions).toContain("NOT the project's approved requirements");
    expect(requirements.minedRules).toBe(false);
    expect(requirements.batched).toBeUndefined();
    expect(requirements.reconstruction).toBe(true);
    expect(requirements.faithfulnessThreshold).toBe(RECONSTRUCTION_FAITHFULNESS_THRESHOLD);
  });

  it("holds the key rules to the bar, and gives them the inputs, of the appendix's rules catalogue", () => {
    const keyRules = READER.find((g) => g.id === "key-rules")!;
    const catalogueRules = CATALOGUE.find((g) => g.id === "rules")!;
    expect(keyRules.instructions).toContain("## Key Business Rules");
    expect(keyRules.instructions).toContain("SUMMARY");
    expect(keyRules.instructions).toContain("appendix (Business Rules & Policies)");
    // The default code-fidelity bar (no lower override), as the catalogue's.
    expect(keyRules.faithfulnessThreshold).toBeUndefined();
    expect(keyRules.faithfulnessThreshold).toBe(catalogueRules.faithfulnessThreshold);
    expect(keyRules.reconstruction).toBeUndefined();
    expect(keyRules.narrative).toBeUndefined();
    // The same inputs: the rules slice and the mined-rule inventory.
    expect(keyRules.minedRules).toBe(true);
    expect(catalogueRules.minedRules).toBe(true);
    expect(keyRules.factSlices).toEqual(catalogueRules.factSlices);
    expect(keyRules.batched).toBeUndefined();
  });

  it("has no main H2 heading that repeats one of the appendix", () => {
    const headings = (ids: string[]): string[] =>
      READER.filter((g) => ids.includes(g.id)).flatMap((g) =>
        [...g.instructions.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
      );
    const appendix = new Set(headings(APPENDIX_IDS));
    expect(headings(MAIN_IDS).filter((heading) => appendix.has(heading))).toEqual([]);
  });

  it("is not used unless asked for", () => {
    expect(CATALOGUE.map((g) => g.id)).toEqual(["overview", "capabilities", ...APPENDIX_IDS]);
    expect(sectionGroupsFor("architecture", { brdLayout: "reader" })).toEqual(
      sectionGroupsFor("architecture"),
    );
  });
});

describe("brdReaderLayoutEnabled", () => {
  it("is on for reader only, and logs a value it does not recognise", () => {
    expect(brdReaderLayoutEnabled()).toBe(true);
    vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "catalogue");
    expect(brdReaderLayoutEnabled()).toBe(false);
    const warn = vi.spyOn(logger, "warn");
    vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "main-plus-appendix");
    expect(brdReaderLayoutEnabled()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "Unrecognised BRD layout setting; the catalogue layout is used",
      expect.objectContaining({
        key: "DOCS_GEN_BRD_LAYOUT",
        value: "main-plus-appendix",
      }),
    );
    warn.mockRestore();
  });
});

describe("planDocumentTopics in the reader layout", () => {
  const plan = (groups: typeof READER, readerLayout: boolean, modules = 102) =>
    planDocumentTopics({
      facts: project(modules),
      groups,
      router: routerFor(fakeModel()),
      sectionMaxChars: 60_000,
      documentMaxChars: 250_000,
      ...(readerLayout ? { readerLayout } : {}),
    });

  it("plans each main section its target, inside 40-60k together, and states every one", () => {
    const { plan: p, lengthLimited } = plan(READER, true);
    expect(p.mainBudgetChars).toBe(BRD_MAIN_TARGET_CHARS);
    const main = p.sections.filter((s) => MAIN_IDS.includes(s.sectionId));
    expect(Object.fromEntries(main.map((s) => [s.sectionId, s.budgetChars]))).toEqual(
      BRD_MAIN_SECTION_TARGETS,
    );
    const total = main.reduce((n, s) => n + s.budgetChars, 0);
    expect(total).toBeGreaterThanOrEqual(40_000);
    expect(total).toBeLessThanOrEqual(60_000);
    for (const id of MAIN_IDS) expect(lengthLimited.has(id)).toBe(true);
    // The appendix's single-call section keeps its own instructions, as it did.
    expect(lengthLimited.has("integrations-and-glossary")).toBe(false);
  });

  it("plans the appendix's catalogue what the catalogue layout plans it, on a project whose catalogue outgrows the budget", () => {
    // Enough modules that the catalogue sections outgrow the default budget
    // and topics are planned out in both layouts (the Miniflux BRD of #706
    // run 9 left out 65).
    const reader = plan(READER, true, 300).plan;
    const catalogue = plan(CATALOGUE, false, 300).plan;
    expect(catalogue.mainBudgetChars).toBeUndefined();
    expect(reader.budgetChars).toBe(catalogue.budgetChars);
    for (const id of APPENDIX_IDS) {
      const a = reader.sections.find((s) => s.sectionId === id)!;
      const b = catalogue.sections.find((s) => s.sectionId === id)!;
      expect({ id, budget: a.budgetChars }).toEqual({
        id,
        budget: b.budgetChars,
      });
      expect(a.topics.map((t) => [t.id, t.budgetChars])).toEqual(
        b.topics.map((t) => [t.id, t.budgetChars]),
      );
      expect(a.dropped.map((t) => t.id)).toEqual(b.dropped.map((t) => t.id));
    }
    const dropped = (p: typeof reader): number =>
      p.sections.reduce((n, s) => n + s.dropped.length, 0);
    expect(dropped(reader)).toBe(dropped(catalogue));
    // Moving the catalogue to an appendix does not by itself bring the
    // planned-out topics (#995) to zero: the appendix is bounded by the same cap.
    expect(dropped(reader)).toBeGreaterThan(0);
  });

  it("is planned whatever DOCS_GEN_TOPIC_PLAN says", async () => {
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "off");
    const provider = fakeModel();
    await run(project(6), provider);
    for (const id of MAIN_IDS) {
      const [call] = callsFor(provider, label(id));
      expect(call.user).toContain(
        `Write at most about ${batchWordBudget(BRD_MAIN_SECTION_TARGETS[id])} words for this section group.`,
      );
    }
    // And the canonical facts block of a planned document is in every prompt.
    expect(callsFor(provider, label("requirements"))[0].user).not.toContain(
      "ADDITIONAL MODULES (facts omitted",
    );
  });
});

describe("the prompts of the reader layout's own sections", () => {
  it("give the key rules and the reconstructed requirements the cite-or-omit guidance, as the catalogue's", async () => {
    const provider = fakeModel();
    await run(project(6), provider);
    for (const id of ["key-rules", "requirements", "rules"]) {
      const [call] = callsFor(provider, label(id));
      expect({ id, guided: call.system.includes("GROUNDING DISCIPLINE") }).toEqual({
        id,
        guided: true,
      });
    }
    // The narrative opening does not get it, as before.
    expect(callsFor(provider, label("overview"))[0].system).not.toContain("GROUNDING DISCIPLINE");
  });

  it("give the key rules the mined-rule inventory the catalogue's rules read", async () => {
    const facts = project(4);
    facts[0] = {
      ...facts[0],
      minedRules: [
        {
          language: "go",
          kind: "validation",
          expression: "len(password) < 6",
          summary: "Password must be at least 6 characters",
          file: "src/m00/user.go",
          line: 163,
          context: null,
        },
      ],
    };
    const provider = fakeModel();
    await run(facts, provider);
    const [keyRules] = callsFor(provider, label("key-rules"));
    expect(keyRules.user).toContain("src/m00/user.go:163");
    expect(callsFor(provider, label("requirements"))[0].user).not.toContain("src/m00/user.go:163");
  });
});

describe("a reader-layout document", () => {
  it("has the main document, the appendix divider, then the appendix, in that order", async () => {
    const provider = fakeModel();
    const result = await run(project(12), provider);
    const md = result.markdown;
    const order = [
      ...MAIN_LABELS.map((l) => `## ${l}\n`),
      APPENDIX_DIVIDER,
      ...APPENDIX_IDS.map((id) => `## ${label(id)}\n`),
    ];
    const at = order.map((text) => md.indexOf(text));
    expect(order.filter((_, i) => at[i] < 0)).toEqual([]);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(md.split(APPENDIX_DIVIDER)).toHaveLength(2);
    // Every section reached the reader: nothing is reported missing.
    expect(result.warnings.filter((w) => w.kind === "section-missing")).toEqual([]);
    // The main part fits its target and holds no module-by-module catalogue.
    const main = mainPartOf(md);
    expect(main.length).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    expect(main).not.toContain(`## ${label("rules")}`);
    expect(main).not.toContain("Shortened for length");
  });

  it("opens the reconstructed requirements with the fixed lead-in, written by METIS", async () => {
    const provider = fakeModel();
    const result = await run(project(6), provider);
    const section = sectionOf(result.markdown, label("requirements"));
    expect(section.startsWith(`## ${label("requirements")}\n\n${REQUIREMENTS_LEAD_IN}\n\n`)).toBe(
      true,
    );
    // The model was not asked to write it, and did not.
    const [call] = callsFor(provider, label("requirements"));
    expect(call.user).not.toContain(REQUIREMENTS_LEAD_IN);
    expect(result.markdown.split(REQUIREMENTS_LEAD_IN)).toHaveLength(2);
  });

  it("de-duplicates the main part and the appendix each on its own", async () => {
    // The requirements reply repeats the appendix's rules heading: one
    // de-duplication over the whole body would drop the appendix's section.
    const provider = fakeModel({
      inject: (call) =>
        call.group === label("requirements")
          ? `\n\n## ${label("rules")}\n\nA heading the model repeated.\n\n`
          : "",
    });
    const result = await run(project(6), provider);
    const appendix = result.markdown.slice(result.markdown.indexOf(APPENDIX_DIVIDER));
    expect(sectionOf(appendix, label("rules"))).toContain("### About m00");
    expect(result.warnings.filter((w) => w.kind === "section-missing")).toEqual([]);
  });

  it("cuts the summaries before the reconstructed requirements, whose text is nowhere else", async () => {
    // The two summary sections written at five times their target; the
    // opening and the requirements at theirs.
    const summaries = [label("capabilities"), label("key-rules")];
    const provider = fakeModel({
      overrun: (call) => (summaries.includes(call.group) ? 5 : 0.8),
    });
    const result = await run(project(12), provider);
    expect(mainPartOf(result.markdown).length).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    for (const heading of summaries) {
      const section = sectionOf(result.markdown, heading);
      expect(section).toContain("The detail behind this section is in the appendix.");
    }
    const requirements = sectionOf(result.markdown, label("requirements"));
    expect(requirements).not.toContain("Shortened for length");
    expect(requirements).toContain("### About m11");
    const cut = result.sections.find((s) => s.sectionLabel === label("requirements"));
    expect(cut?.omittedTopics ?? []).toEqual([]);
  });

  it("holds the main part to 60k when the model overruns, and lists what it left out", async () => {
    // Every main section written at four times its target; the appendix at its share.
    const provider = fakeModel({
      overrun: (call) => (MAIN_LABELS.includes(call.group) ? 4 : 0.8),
    });
    const result = await run(project(12), provider);
    const main = mainPartOf(result.markdown);
    expect(main.length).toBeLessThanOrEqual(BRD_MAIN_MAX_CHARS);
    // It was cut, not written short: the drafts were three times the cap.
    expect(main.length).toBeGreaterThan(BRD_MAIN_MAX_CHARS - 6_000);
    expect(main).toContain("The main part of this document is limited to about 60k characters");
    const listed = result.sections
      .filter((s) => MAIN_LABELS.includes(s.sectionLabel))
      .flatMap((s) => s.omittedTopics ?? []);
    expect(listed.length).toBeGreaterThan(0);
    // The appendix was not cut for it: the document has room.
    const appendix = result.markdown.slice(result.markdown.indexOf(APPENDIX_DIVIDER));
    expect(appendix).not.toContain("Shortened for length");
    expect(sectionOf(result.markdown, label("rules"))).toContain("### About m11");
  });

  it("keeps the body within the document cap, the appendix taking what the main part leaves", async () => {
    vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "90000");
    const provider = fakeModel({ overrun: 3 });
    const result = await run(project(12), provider);
    const md = result.markdown;
    const main = mainPartOf(md);
    // Under a 90k cap the main part is held to half of it.
    expect(main.length).toBeLessThanOrEqual(45_000);
    const footer = md.lastIndexOf("\n\n---\n\n*This ");
    const appendix = md.slice(md.indexOf(APPENDIX_DIVIDER) + APPENDIX_DIVIDER.length, footer);
    expect(main.length + APPENDIX_DIVIDER.length + appendix.length).toBeLessThanOrEqual(90_000);
    expect(appendix).toContain("DOCS_GEN_DOCUMENT_MAX_CHARS");
  });
});

describe("the catalogue layout", () => {
  it("is written as before: no appendix and no main-part sections", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "6000");
    expect(process.env.DOCS_GEN_BRD_LAYOUT).toBeUndefined();
    const provider = fakeModel();
    const result = await run(project(6), provider);
    expect(result.markdown).not.toContain(APPENDIX_DIVIDER);
    expect(result.markdown).not.toContain("## Key Business Rules");
    expect(provider.calls.map((c) => c.group)).not.toContain(label("requirements"));
    for (const call of provider.calls) expect(call.user).not.toContain("LENGTH LIMIT");
  });
});
