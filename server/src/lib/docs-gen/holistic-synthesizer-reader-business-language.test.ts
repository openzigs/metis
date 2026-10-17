/**
 * #1223 — the main part of a reader-layout BRD is written for a business
 * reader: every main section's prompt carries the business-language rule (the
 * appendix's do not), and each main section, as fitted, is checked for code
 * identifiers, with the result in its provenance entry. Through
 * `sectionGroupsFor`, `synthesizeFinalDocument` and the provenance manifest.
 * The fake model writes one H3 topic per module and can be told to add text.
 * No network, no database, no live model.
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
import { BRD_MAIN_SECTION_TARGETS } from "./brd-layout.js";
import {
  buildGeneratedDocVersionManifest,
  parseGeneratedDocVersionManifest,
} from "./generated-doc-provenance.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2ProviderBundle,
  type Phase2Router,
} from "./holistic-synthesizer.js";
import {
  CODE_IDENTIFIER_EXAMPLE_MAX_CHARS,
  CODE_IDENTIFIER_EXAMPLES_MAX,
  MAIN_PART_LANGUAGE_RULES,
} from "./main-part-language.js";

// ── Fixture ───────────────────────────────────────────────────────────────

function mod(name: string, size: number): ModuleFacts {
  const bullets = (kind: string): string =>
    Array.from({ length: size }, (_, i) => `- ${kind} ${i} of ${name}: a policy applies.`).join(
      "\n",
    );
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 4,
    facts: [
      "PURPOSE",
      `${name} handles one business capability.`,
      "RULES",
      bullets("rule"),
      "WORKFLOWS",
      bullets("step"),
      "FORMULAS",
      bullets("formula"),
      "ENTITIES",
      bullets("entity"),
      "INTEGRATIONS",
      bullets("integration"),
      "KEY_APIS",
      bullets("api"),
    ].join("\n"),
    formulas: [],
    topClasses: [],
  };
}

const project = (count: number): ModuleFacts[] =>
  Array.from({ length: count }, (_, i) => mod(`m${String(i).padStart(2, "0")}`, 2 * count - i));

interface Call {
  group: string;
  system: string;
}

interface FakeOptions {
  /** Extra text for a call's first paragraph. */
  inject?: (group: string) => string;
  /** Extra text for a call's LAST paragraph: the first text a length fit gives up. */
  injectLast?: (group: string) => string;
  /** Write this many times the budget the prompt states (default: keep to it). */
  overrun?: (group: string) => number;
}

const PARAGRAPH = "This policy applies to every request the capability receives today. ";

function fakeModel(options: FakeOptions = {}): AIProvider & { calls: Call[] } {
  const calls: Call[] = [];
  const reply = (group: string, user: string, modules: string[]): string => {
    const limit = /write at most about (\d+) words/i.exec(user);
    const total = limit ? Number(limit[1]) * 6 * (options.overrun?.(group) ?? 0.8) : 400;
    const each = Math.max(120, Math.floor(total / modules.length));
    const paragraphs = Math.max(1, Math.round(each / 150));
    const topics = modules.map((m, i) =>
      [
        `### About ${m}`,
        ...Array.from(
          { length: paragraphs },
          (_, p) =>
            `${m} rule ${p}. ${p === 0 && i === 0 ? (options.inject?.(group) ?? "") : ""}${
              p === paragraphs - 1 && i === modules.length - 1
                ? (options.injectLast?.(group) ?? "")
                : ""
            }${PARAGRAPH.repeat(2)}`,
        ),
      ].join("\n\n"),
    );
    return `## ${group}\n\n${topics.join("\n\n")}`;
  };
  const provider = {
    key: "anthropic",
    model: "fake-section-model",
    offline: false,
    calls,
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      const group = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      const facts = user.slice(
        user.indexOf("=== EXTRACTED MODULE FACTS ==="),
        user.indexOf("=== END MODULE FACTS ==="),
      );
      const modules = [...new Set([...facts.matchAll(/^### MODULE: (\S+)/gm)].map((m) => m[1]))];
      calls.push({ group, system: String(messages[0].content) });
      yield {
        type: "delta",
        content: reply(group, user, modules.length > 0 ? modules : ["everything"]),
      };
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
const READER = sectionGroupsFor("business-requirements", { brdLayout: "reader" });
const CATALOGUE = sectionGroupsFor("business-requirements");
const MAIN_IDS = Object.keys(BRD_MAIN_SECTION_TARGETS);
const label = (id: string): string => READER.find((g) => g.id === id)!.label;
const MAIN_LABELS = MAIN_IDS.map(label);

type Result = Awaited<ReturnType<typeof synthesizeFinalDocument>>;

function run(facts: ModuleFacts[], provider: AIProvider): Promise<Result> {
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

const flagsOf = (result: Result): Record<string, number | undefined> =>
  Object.fromEntries(result.sections.map((s) => [s.sectionLabel, s.codeIdentifiers?.count]));

beforeEach(() => {
  scoreFaithfulnessMock.mockReset();
  vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "6000");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "100000");
  vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "reader");
});
afterEach(() => vi.unstubAllEnvs());

// ── Tests ─────────────────────────────────────────────────────────────────

describe("the main part's prompts", () => {
  it("ask every main section, and no appendix section, for business language", () => {
    for (const group of READER) {
      expect({
        id: group.id,
        rules: group.instructions.includes(MAIN_PART_LANGUAGE_RULES),
      }).toEqual({ id: group.id, rules: MAIN_IDS.includes(group.id) });
    }
    for (const group of CATALOGUE) {
      expect(group.instructions).not.toContain(MAIN_PART_LANGUAGE_RULES);
    }
  });

  it("ask the capabilities for a business summary, gated as the catalogue's", () => {
    const capabilities = READER.find((g) => g.id === "capabilities")!;
    const before = CATALOGUE.find((g) => g.id === "capabilities")!;
    expect(capabilities.label).toBe(before.label);
    expect(capabilities.instructions).toContain("## Core Business Capabilities");
    expect(capabilities.instructions).toContain("SUMMARY");
    expect(capabilities.instructions).toContain("NOT one entry per code module");
    expect(capabilities.instructions).not.toBe(before.instructions);
    const { instructions: _a, ...gating } = capabilities;
    const { instructions: _b, ...beforeGating } = before;
    expect(gating).toEqual(beforeGating);
  });

  it("still ask the overview for its actor diagram (#1175), which the rules exempt (#1226 review)", () => {
    const overview = READER.find((g) => g.id === "overview")!.instructions;
    const diagram = overview.indexOf("include a Mermaid `graph LR` diagram");
    expect(diagram).toBeGreaterThan(-1);
    // The rules come after the diagram request, so they must not withdraw it.
    expect(overview.indexOf(MAIN_PART_LANGUAGE_RULES)).toBeGreaterThan(diagram);
    expect(MAIN_PART_LANGUAGE_RULES).toMatch(
      /exception is a Mermaid diagram this section asks for/,
    );
  });

  it("ask for acceptance criteria a business reader can check, not API contracts", () => {
    const requirements = READER.find((g) => g.id === "requirements")!;
    expect(requirements.instructions).toContain("not as an API or database contract");
  });

  it("reach the model in each main section's system message, after the shared rules", async () => {
    const provider = fakeModel();
    await run(project(6), provider);
    for (const call of provider.calls) {
      const main = MAIN_LABELS.includes(call.group);
      expect({ group: call.group, rules: call.system.includes(MAIN_PART_LANGUAGE_RULES) }).toEqual({
        group: call.group,
        rules: main,
      });
      if (main) {
        expect(call.system.indexOf(MAIN_PART_LANGUAGE_RULES)).toBeGreaterThan(
          call.system.indexOf("SECTION GROUP TO PRODUCE"),
        );
      }
    }
  });
});

describe("the main-part code identifier check", () => {
  it("records each main section's code identifiers in its provenance entry, and none for the appendix", async () => {
    const provider = fakeModel({
      inject: (group) =>
        group === label("capabilities")
          ? "When `ShouldMarkAsReadOnView(user)` is true the entry's published_at is kept. "
          : group === label("rules")
            ? "The `feed_id` column is checked. "
            : "",
    });
    const result = await run(project(6), provider);
    const capabilities = result.sections.find((s) => s.sectionLabel === label("capabilities"));
    expect(capabilities?.codeIdentifiers).toEqual({
      count: 2,
      examples: [
        { kind: "inline-code", text: "ShouldMarkAsReadOnView(user)" },
        { kind: "snake-case", text: "published_at" },
      ],
    });
    const flags = flagsOf(result);
    for (const id of ["overview", "key-rules", "requirements"]) {
      expect({ id, count: flags[label(id)] }).toEqual({ id, count: 0 });
    }
    // The appendix is where code names belong: it is not checked.
    expect(flags[label("rules")]).toBeUndefined();
  });

  it("checks the main part as fitted: text the length fit cut is not reported", async () => {
    const provider = fakeModel({
      // Every main section at four times its target: the main-part fit cuts
      // the summaries' tails first (the drafts are within the section cap).
      overrun: (group) => (MAIN_LABELS.includes(group) ? 4 : 0.8),
      injectLast: (group) => (group === label("capabilities") ? "Uses `cut_column`. " : ""),
      inject: (group) => (group === label("capabilities") ? "Uses `kept_column`. " : ""),
    });
    const result = await run(project(12), provider);
    const capabilities = result.sections.find((s) => s.sectionLabel === label("capabilities"));
    expect(result.markdown).not.toContain("cut_column");
    expect(capabilities?.codeIdentifiers).toEqual({
      count: 1,
      examples: [{ kind: "inline-code", text: "kept_column" }],
    });
  });

  it("is not run on the catalogue layout", async () => {
    vi.stubEnv("DOCS_GEN_BRD_LAYOUT", "catalogue");
    const provider = fakeModel({ inject: () => "The `feed_id` column. " });
    const result = await run(project(6), provider);
    expect(result.sections.every((s) => s.codeIdentifiers === undefined)).toBe(true);
  });
});

describe("the provenance manifest", () => {
  const input = (
    codeIdentifiers?: Parameters<
      typeof buildGeneratedDocVersionManifest
    >[0]["sections"][number]["codeIdentifiers"],
  ): Parameters<typeof buildGeneratedDocVersionManifest>[0] => {
    const tuning = docsGenTuning("anthropic", "m");
    return {
      revision: { projectId: "p1", generatedDocumentId: "d1", version: 1 },
      title: "BRD",
      scope: "full",
      docType: "business-requirements",
      generatedAt: new Date("2026-10-17T00:00:00Z"),
      policy: {
        projectId: "p1",
        generatedDocumentId: "d1",
        actor: { userId: "u", role: "admin" },
        aclSubjects: [],
        sharedDocumentIds: [],
        allowWebResearch: false,
      },
      phase1Tuning: tuning,
      phase2Router: { primary: { tuning } as Phase2ProviderBundle, hybrid: null },
      phase1PromptVersion: 1,
      selectedEvidence: [],
      graphFingerprint: null,
      sourceRepositories: [],
      sections: [
        {
          sectionLabel: "Core Business Capabilities",
          sectionIndex: 1,
          providerKind: "anthropic",
          model: "m",
          factsSourceIds: [],
          groundingSourceIds: [],
          ...(codeIdentifiers ? { codeIdentifiers } : {}),
        },
      ],
    };
  };

  it("keeps a section's code identifiers through a write and a read", () => {
    const report = {
      count: 3,
      examples: [
        { kind: "inline-code" as const, text: "EntryStatusUnread" },
        { kind: "file-path" as const, text: "internal/storage/entry.go" },
      ],
    };
    const parsed = parseGeneratedDocVersionManifest(
      buildGeneratedDocVersionManifest(input(report)),
    );
    expect(parsed.sections[0].codeIdentifiers).toEqual(report);
  });

  it("still reads a manifest written before the check, and writes none without one", () => {
    const parsed = parseGeneratedDocVersionManifest(buildGeneratedDocVersionManifest(input()));
    expect(parsed.sections[0]).not.toHaveProperty("codeIdentifiers");
  });

  it("rejects a kind the check does not produce", () => {
    const raw = JSON.parse(
      buildGeneratedDocVersionManifest(
        input({ count: 1, examples: [{ kind: "inline-code", text: "x_y" }] }),
      ),
    );
    raw.sections[0].codeIdentifiers.examples[0].kind = "guess";
    expect(() => parseGeneratedDocVersionManifest(raw)).toThrow();
  });

  it("caps examples and their text as the check writes them (#1226 review)", () => {
    const written = (): { sections: { codeIdentifiers: { examples: unknown[] } }[] } =>
      JSON.parse(
        buildGeneratedDocVersionManifest(
          input({
            count: CODE_IDENTIFIER_EXAMPLES_MAX,
            examples: Array.from({ length: CODE_IDENTIFIER_EXAMPLES_MAX }, (_, i) => ({
              kind: "snake-case" as const,
              text: i === 0 ? "x".repeat(CODE_IDENTIFIER_EXAMPLE_MAX_CHARS) : `f_${i}`,
            })),
          }),
        ),
      );
    expect(() => parseGeneratedDocVersionManifest(written())).not.toThrow();
    const tooMany = written();
    tooMany.sections[0].codeIdentifiers.examples.push({ kind: "snake-case", text: "one_more" });
    expect(() => parseGeneratedDocVersionManifest(tooMany)).toThrow();
    const tooLong = written();
    tooLong.sections[0].codeIdentifiers.examples[0] = {
      kind: "snake-case",
      text: "x".repeat(CODE_IDENTIFIER_EXAMPLE_MAX_CHARS + 1),
    };
    expect(() => parseGeneratedDocVersionManifest(tooLong)).toThrow();
  });
});
