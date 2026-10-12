/**
 * #1070 — with `DOCS_GEN_TOPIC_PLAN` off, which is the default, a
 * business-requirements document is generated EXACTLY as it was before the
 * topic plan existed: the same prompts, the same document, the same reuse
 * inputs. So no existing BRD pays a rewrite on upgrade, and a section stored
 * before the upgrade is still reused after it.
 *
 * This is not the new code compared with itself. The fixtures in
 * `__fixtures__/` were produced by the code BEFORE #1070 (`origin/main` at
 * 7f8ff4c0, the commit the change is based on), by running this very file
 * there:
 *
 *   mkdir /tmp/before-1070 && git archive 7f8ff4c0 | tar -x -C /tmp/before-1070
 *   cp server/src/lib/docs-gen/holistic-synthesizer-topic-plan-off.test.ts \
 *      /tmp/before-1070/server/src/lib/docs-gen/
 *   cd /tmp/before-1070 && pnpm install --frozen-lockfile --prod=false \
 *      && pnpm --filter @metis/shared build && cd server \
 *      && WRITE_BEFORE_1070_FIXTURE=1 npx vitest run \
 *           src/lib/docs-gen/holistic-synthesizer-topic-plan-off.test.ts
 *
 * and copying the two JSON files back (prettier then formats them; the values
 * are untouched). It imports nothing #1070 added, so it runs unchanged on
 * both sides.
 *
 * Two scenarios, each one the plan WOULD change if it were on:
 *
 *   1. `brd-before-1070.json` — module facts that carry shared constants and a
 *      formula (a facts sheet), a model that writes three times what it is
 *      asked, and section and document caps that both bind. No citations and
 *      no fact-checking.
 *   2. `brd-before-1070-grounded.json` (#1119) — the same under hybrid routing
 *      with a retrieved source: every paragraph cites a source, the real claim
 *      extractor and judge check every section, one module lives in a
 *      directory named `canon`, and in the `escalated` variant every local
 *      section falls below its bar and is written again by the cloud model
 *      (four sections written in batches and one written in a single call).
 *
 * A fixture pins the off path only as far as its scenario reaches: scenario 1
 * alone left every off-path line inside the grounding and escalation code to
 * reading. When the off path is changed again, regenerate on the base, then
 * mutate each off-path line the change touches and check which the fixtures
 * kill.
 *
 * No network, no database, no live model.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../finops/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../finops/index.js")>();
  return { ...actual, recordUsage: vi.fn() };
});

import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../ai/types.js";
import type { ExtractedFormula } from "../code-graph/formula-extractor.js";
import type { PersistedMinedRule } from "./fact-slices.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2ProviderBundle,
  type Phase2Router,
} from "./holistic-synthesizer.js";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "brd-before-1070.json",
);
/** #1119 — the second scenario: citations, fact-checking and escalation. */
const GROUNDED_FIXTURE = join(dirname(FIXTURE), "brd-before-1070-grounded.json");
const WRITING = process.env.WRITE_BEFORE_1070_FIXTURE === "1";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

// ── Scenario ──────────────────────────────────────────────────────────────

const bullets = (kind: string, name: string, n: number, extra = ""): string =>
  Array.from(
    { length: n },
    (_, i) => `- ${kind} ${i} of ${name}: the request is checked against the configured policy.`,
  )
    .concat(extra ? [extra] : [])
    .join("\n");

const constant = (name: string, value: string, line: number): PersistedMinedRule => ({
  language: "go",
  kind: "const",
  expression: `const ${name} = ${value}`,
  summary: `Constant \`${name}\` = ${value}`,
  file: "src/m00/limits.go",
  line,
  context: null,
});

const INTERVAL: ExtractedFormula = {
  kind: "arithmetic",
  expression: "(7 * 24 * time.Hour) / time.Duration(weeklyCount*factor)",
  description: "",
  name: "interval",
  resolvedValue: null,
  filePath: "src/m00/feed.go",
  startLine: 131,
  endLine: 131,
  symbolContext: "src/m00/feed.go::ScheduleNextCheck",
};

/** Ten modules, larger first; the first two share two constants and a formula. */
function project(): ModuleFacts[] {
  return Array.from({ length: 10 }, (_, i) => {
    const name = `m${String(i).padStart(2, "0")}`;
    const size = 20 - i;
    const shared =
      i === 0
        ? {
            rules:
              "- A page never holds more than `maxPageSize` entries; exports are `exportFormatName`.",
            workflows: "- `ScheduleNextCheck` sets the interval from `weeklyCount`.",
            formulas: "- `ScheduleNextCheck` computes the interval.",
          }
        : i === 1
          ? {
              rules: "- `ScheduleNextCheck` bounds the interval.",
              workflows:
                "- Listing stops after `maxPageSize` entries; the job writes `exportFormatName`.",
              formulas: "",
            }
          : { rules: "", workflows: "", formulas: "" };
    return {
      modulePath: `src/${name}`,
      moduleName: name,
      classCount: 1,
      methodCount: 4,
      facts: [
        "PURPOSE",
        `${name} handles one business capability.`,
        "RULES",
        bullets("rule", name, size, shared.rules),
        "WORKFLOWS",
        bullets("step", name, size, shared.workflows),
        "FORMULAS",
        bullets("formula", name, Math.max(1, size >> 1), shared.formulas),
        "ENTITIES",
        bullets("entity", name, Math.max(1, size >> 1)),
        "INTEGRATIONS",
        bullets("integration", name, 1),
        "KEY_APIS",
        bullets("api", name, 1),
      ].join("\n"),
      formulas: i === 0 ? [INTERVAL] : [],
      topClasses: [],
      ...(i === 0
        ? {
            minedRules: [
              constant("maxPageSize", "100", 12),
              constant("exportFormatName", '"ndjson"', 14),
            ],
          }
        : {}),
    };
  });
}

interface Call {
  group: string;
  system: string;
  user: string;
}

const PARAGRAPH = "This policy applies to every request the capability receives today. ";

/** Writes one H3 topic per module, at three times the budget its prompt states. */
function fakeModel(): AIProvider & { calls: Call[] } {
  const calls: Call[] = [];
  const provider = {
    key: "anthropic",
    model: "fake-section-model",
    offline: false,
    calls,
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      const system = String(messages[0].content);
      const group = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      calls.push({ group, system, user });
      const facts = user.slice(
        user.indexOf("=== EXTRACTED MODULE FACTS ==="),
        user.indexOf("=== END MODULE FACTS ==="),
      );
      const found = [...new Set([...facts.matchAll(/^### MODULE: (\S+)/gm)].map((m) => m[1]))];
      const modules = found.length > 0 ? found : ["everything"];
      const limit = /write at most about (\d+) words/i.exec(user);
      const total = limit ? Number(limit[1]) * 6 * 3 : 2_400 * modules.length;
      const paragraphs = Math.max(1, Math.round(total / modules.length / 150));
      const topics = modules.map((m) =>
        [
          `### About ${m}`,
          ...Array.from({ length: paragraphs }, (_, p) => `${m} rule ${p}. ${PARAGRAPH.repeat(2)}`),
        ].join("\n\n"),
      );
      yield { type: "delta", content: `## ${group}\n\n${topics.join("\n\n")}` };
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

type Result = Awaited<ReturnType<typeof synthesizeFinalDocument>>;

async function generate(provider: AIProvider, previous?: unknown): Promise<Result> {
  return synthesizeFinalDocument(
    project(),
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
      ...(previous ? { previousManifest: { sectionSynthesis: previous } as never } : {}),
    },
  );
}

/** Everything a run produced that the plan could have touched. */
function capture(provider: { calls: Call[] }, result: Result) {
  return {
    calls: provider.calls.map((call) => ({
      group: call.group,
      systemChars: call.system.length,
      systemSha256: sha(call.system),
      userChars: call.user.length,
      userSha256: sha(call.user),
    })),
    markdownChars: result.markdown.length,
    markdownSha256: sha(result.markdown),
    warnings: result.warnings,
    sections: result.sections,
    sectionSynthesis: result.sectionSynthesis,
  };
}

interface Fixture extends ReturnType<typeof capture> {
  producedBy: string;
}

// ── Scenario 2 (#1119): citations, fact-checking and escalation ───────────
//
// The first scenario's model cites nothing and its run has no claim extractor,
// so it cannot see a change inside the grounding or the escalation code. This
// one runs under hybrid routing with a retrieved source: the catalogue
// sections are written by a local model and fact-checked by the REAL claim
// extractor and judge over the fake provider, every paragraph cites a source,
// and in the `escalated` variant every local section scores below its bar and
// is written again by the cloud model.

/**
 * The first scenario's project, with two changes. Its last module is moved to
 * a top-level directory named `canon`: its legacy facts id is `facts:canon:9`,
 * which is also how the id of a canonical fact begins (#1119 item 1). And its
 * first module has more rules than one batch reads, so the rules section
 * reads it in several parts.
 */
function groundedProject(): ModuleFacts[] {
  const modules = project();
  const first = modules[0];
  modules[0] = {
    ...first,
    facts: first.facts.replace(
      "RULES\n",
      `RULES\n${bullets("further rule", first.moduleName, 110)}\n`,
    ),
  };
  const last = modules[modules.length - 1];
  modules[modules.length - 1] = {
    ...last,
    modulePath: "canon",
    moduleName: "canon",
    facts: last.facts.split(last.moduleName).join("canon"),
  };
  return modules;
}

function retrieved(): GroundingContext {
  return {
    sources: [
      {
        sourceId: "rag:doc:0",
        kind: "rag",
        label: "policy.md",
        text: "Every request is checked against the configured policy.",
      },
    ],
    sourceIds: new Set(["rag:doc:0"]),
    isEmpty: false,
  } as unknown as GroundingContext;
}

type ModelName = "local" | "cloud";

interface GroundedLog {
  /** Every section-writing call, of both models, in order. */
  calls: Array<Call & { provider: ModelName }>;
  /** Every claim-decomposition and judge call, byte for byte (messages and options). */
  chats: Array<{ provider: ModelName; kind: "claims" | "judge"; request: string }>;
}

/**
 * Writes as {@link fakeModel} does, and also: each paragraph cites one of the
 * sources its prompt lists; each module gets TWO H3 topics (so a shortened
 * section leaves out more topics than its note lists) with an H4 and a table
 * between them (one row of its own, one that every module repeats); and the
 * overview is one long topic (so its note names no topic). It decomposes a
 * passage into one claim per fifth paragraph. As a judge the cloud model
 * supports every claim and the local model every second one, so a local
 * section scores 50%.
 */
function groundedModel(name: ModelName, log: GroundedLog): AIProvider {
  const provider = {
    key: name === "local" ? "local-gemma" : "anthropic",
    model: `fake-${name}-model`,
    offline: false,
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      const system = String(messages[0].content);
      const group = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      log.calls.push({ provider: name, group, system, user });
      const facts = user.slice(
        user.indexOf("=== EXTRACTED MODULE FACTS ==="),
        user.indexOf("=== END MODULE FACTS ==="),
      );
      const found = [...new Set([...facts.matchAll(/^### MODULE: (\S+)/gm)].map((m) => m[1]))];
      const oneTopic = group.startsWith("Overview") || found.length === 0;
      const modules = oneTopic ? ["everything"] : found;
      const ids = [
        ...new Set([...`${system}\n${user}`.matchAll(/\[SOURCE id=(\S+) kind=/g)].map((m) => m[1])),
      ];
      const limit = /write at most about (\d+) words/i.exec(user);
      const total = limit ? Number(limit[1]) * 6 * 3 : 2_400 * Math.max(1, found.length);
      const paragraphs = Math.max(2, Math.round(total / modules.length / 150));
      const topics = modules.map((m, t) => {
        const written = Array.from(
          { length: paragraphs },
          (_, p) =>
            `${m} rule ${p} as the ${name} model wrote it. ${PARAGRAPH.repeat(2)}${
              ids.length > 0 ? `[${ids[(t + p) % ids.length]}]` : ""
            }`,
        );
        const half = oneTopic ? 0 : Math.ceil(paragraphs / 2);
        return [
          `### About ${m}`,
          ...written.slice(0, half),
          `#### Limits of ${m}`,
          [
            "| Limit | Value |",
            "| --- | --- |",
            `| ${m} page size | 100 |`,
            "| timeout | 30 |",
          ].join("\n"),
          ...(oneTopic ? [] : [`### More about ${m}`]),
          ...written.slice(half),
        ].join("\n\n");
      });
      yield { type: "delta", content: `## ${group}\n\n${topics.join("\n\n")}` };
      yield { type: "done", finishReason: "stop" };
    },
    async chat(messages: ChatMessage[], opts: ChatOptions = {}) {
      const request = JSON.stringify({ messages, opts: { ...opts, signal: undefined } });
      const user = String(messages[messages.length - 1].content);
      if (String(messages[0].content).includes("strict faithfulness judge")) {
        log.chats.push({ provider: name, kind: "judge", request });
        const block = user.slice(
          user.indexOf("=== CLAIMS TO JUDGE"),
          user.indexOf("=== END CLAIMS"),
        );
        const claims = [...block.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
        return {
          content: JSON.stringify({
            verdicts: claims.map((claim, i) => ({
              claim,
              supported: name === "cloud" || i % 2 === 0,
              sourceIds: [],
            })),
          }),
          finishReason: "stop",
        };
      }
      log.chats.push({ provider: name, kind: "claims", request });
      const passage = user.slice(
        user.indexOf("=== PASSAGE ===\n") + "=== PASSAGE ===\n".length,
        user.indexOf("\n=== END PASSAGE ==="),
      );
      const claims = passage
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => / rule \d*[05] as the /.test(line))
        .map((line) => ({
          claim: line.replace(/\s*\[[^\]\s]+\]$/, ""),
          sourceIds: [...line.matchAll(/\[([^\]\s]+)\]/g)].map((m) => m[1]),
        }));
      return { content: JSON.stringify({ claims }), finishReason: "stop" };
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
  return provider as unknown as AIProvider;
}

/** Catalogue sections on the local model, narrative ones on the cloud model. */
function hybridRouter(log: GroundedLog): Phase2Router {
  const bundleOf = (
    kind: "local" | "anthropic",
    provider: AIProvider,
    factsCharCap: number,
  ): Phase2ProviderBundle => ({
    kind,
    provider,
    supportsCaching: false,
    factsCharCap,
    tuning: docsGenTuning(kind, provider.model),
  });
  const local = bundleOf("local", groundedModel("local", log), 6_000);
  // A larger facts budget, so an escalated section is planned again, differently.
  const escalation = bundleOf("anthropic", groundedModel("cloud", log), 9_000);
  return { primary: local, hybrid: { local, escalation } };
}

type Variant = "grounded" | "escalated";

/** `escalated` also writes each below-bar local section again on the cloud model. */
function stubVariant(variant: Variant): void {
  // One batch at a time: the calls are recorded in the order they are made.
  vi.stubEnv("DOCS_GEN_PHASE2_CONCURRENCY", "1");
  if (variant === "escalated") {
    vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "true");
    vi.stubEnv("DOCS_GEN_MAX_ESCALATIONS", "7");
  }
}

async function generateGrounded(log: GroundedLog, previous?: unknown): Promise<Result> {
  return synthesizeFinalDocument(
    groundedProject(),
    META,
    "business-requirements",
    "BRD",
    hybridRouter(log),
    "p1",
    retrieved(),
    undefined,
    undefined,
    undefined,
    {
      effectiveConfigHash: "cfg",
      ...(previous ? { previousManifest: { sectionSynthesis: previous } as never } : {}),
    },
  );
}

const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]: .*$/gm;

interface GroundedCapture {
  calls: Array<{ provider: ModelName; group: string; userSha256: string; moduleParts: number }>;
  chats: Array<{ provider: ModelName; kind: "claims" | "judge"; chars: number; sha256: string }>;
  markdownChars: number;
  markdownSha256: string;
  footnoteDefinitions: number;
  footnoteDefinitionsChars: number;
  canonFootnotes: string[];
  warnings: unknown[];
  sections: Array<{ sectionLabel: string; model: string; omittedTopics?: string[] }>;
  selectedEvidence: Array<{ sourceId: string }>;
  grounding: unknown;
  regeneration: unknown;
  sectionSynthesis: { records: Array<{ sectionId: string; markdown: string }> } | null;
}

/** Everything a grounded run produced, read back as the fixture stores it. */
function captureGrounded(log: GroundedLog, result: Result): GroundedCapture {
  const definitions = result.markdown.match(FOOTNOTE_DEFINITION) ?? [];
  // Through JSON, so that an absent key and an `undefined` one are the same.
  return JSON.parse(
    JSON.stringify({
      calls: log.calls.map((call) => ({
        provider: call.provider,
        group: call.group,
        // Entries of a module that one batch could not read whole.
        moduleParts: (call.user.match(/^### MODULE: \S+ \(part \d+ of \d+\)$/gm) ?? []).length,
        systemChars: call.system.length,
        systemSha256: sha(call.system),
        userChars: call.user.length,
        userSha256: sha(call.user),
      })),
      chats: log.chats.map((chat) => ({
        provider: chat.provider,
        kind: chat.kind,
        chars: chat.request.length,
        sha256: sha(chat.request),
      })),
      markdownChars: result.markdown.length,
      markdownSha256: sha(result.markdown),
      footnoteDefinitions: definitions.length,
      footnoteDefinitionsChars: definitions.join("\n").length,
      canonFootnotes: definitions.filter((line) => line.includes("`canon`")),
      warnings: result.warnings,
      sections: result.sections,
      selectedEvidence: result.selectedEvidence.map((source) => ({
        ...source,
        text: sha(source.text),
      })),
      grounding: result.grounding ?? null,
      regeneration: result.regeneration ?? null,
      sectionSynthesis: result.sectionSynthesis ?? null,
    }),
  ) as GroundedCapture;
}

type GroundedFixture = Record<Variant, GroundedCapture> & { producedBy: string };

async function runGrounded(variant: Variant): Promise<GroundedCapture> {
  stubVariant(variant);
  const log: GroundedLog = { calls: [], chats: [] };
  return captureGrounded(log, await generateGrounded(log));
}

/** Two or three modules to a batch, and caps that both bind for these models. */
function stubCaps(): void {
  vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "6000");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "16384");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "9000");
  vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "30000");
}

beforeEach(() => {
  // The header carries the date.
  vi.useFakeTimers({ now: new Date("2026-01-15T12:00:00Z"), toFake: ["Date"] });
  stubCaps();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe.runIf(WRITING)("the fixture, written by the code before #1070", () => {
  it("records what that code generates", async () => {
    const provider = fakeModel();
    const result = await generate(provider);
    const fixture: Fixture = {
      producedBy:
        "holistic-synthesizer-topic-plan-off.test.ts with WRITE_BEFORE_1070_FIXTURE=1, on the code before #1070",
      ...capture(provider, result),
    };
    mkdirSync(dirname(FIXTURE), { recursive: true });
    writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
    expect(existsSync(FIXTURE)).toBe(true);
  });

  it("records what that code generates with citations, fact-checking and escalation", async () => {
    const grounded = await runGrounded("grounded");
    vi.unstubAllEnvs();
    stubCaps();
    const escalated = await runGrounded("escalated");
    const fixture: GroundedFixture = {
      producedBy:
        "holistic-synthesizer-topic-plan-off.test.ts with WRITE_BEFORE_1070_FIXTURE=1, on the code before #1070",
      grounded,
      escalated,
    };
    writeFileSync(GROUNDED_FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
    expect(existsSync(GROUNDED_FIXTURE)).toBe(true);
  });
});

describe.skipIf(WRITING)("a BRD with the topic plan off is what it was before #1070", () => {
  const before = (): Fixture => JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;

  it("has a fixture that exercises what the plan would change", () => {
    const fixture = before();
    const groups = sectionGroupsFor("business-requirements");
    expect(fixture.sectionSynthesis!.records.map((r) => r.sectionId)).toEqual(
      groups.map((g) => g.id),
    );
    // Catalogue sections written in several calls, a section cap that cut and
    // a document cap that cut again.
    expect(fixture.calls.length).toBeGreaterThan(groups.length + 4);
    expect(fixture.sections.filter((s) => s.omittedTopics?.length).length).toBeGreaterThan(1);
    expect(
      fixture.sectionSynthesis!.records.some((r) => r.markdown.includes("Shortened for length")),
    ).toBe(true);
    expect(fixture.markdownChars).toBeGreaterThan(25_000);
  });

  it.each([
    { setting: "unset (the default)", value: undefined },
    { setting: "off", value: "off" },
    { setting: "a value that is not `on`", value: "true" },
  ])(
    "generates the same prompts, document and reuse inputs with the setting $setting",
    async ({ value }) => {
      if (value !== undefined) vi.stubEnv("DOCS_GEN_TOPIC_PLAN", value);
      else expect(process.env.DOCS_GEN_TOPIC_PLAN).toBeUndefined();
      const provider = fakeModel();
      const now = capture(provider, await generate(provider));
      const { producedBy: _producedBy, ...then } = before();
      // Every prompt of every call, byte for byte (by length and SHA-256).
      expect(now.calls).toEqual(then.calls);
      // The document.
      expect(now.markdownSha256).toBe(then.markdownSha256);
      expect(now.markdownChars).toBe(then.markdownChars);
      expect(now.warnings).toEqual(then.warnings);
      expect(now.sections).toEqual(then.sections);
      // The reuse records: input hashes, stored text and output hashes.
      expect(JSON.parse(JSON.stringify(now.sectionSynthesis))).toEqual(then.sectionSynthesis);
    },
  );

  it("reuses every section stored before #1070: no model call, the same document", async () => {
    const fixture = before();
    const provider = fakeModel();
    const result = await generate(provider, fixture.sectionSynthesis);
    expect(provider.calls).toEqual([]);
    expect(result.regeneration).toEqual({ mode: "unchanged", changed: [] });
    expect(sha(result.markdown)).toBe(fixture.markdownSha256);
    expect(result.sections).toEqual(fixture.sections);
  });

  it("rewrites those sections once when the plan is turned on, and not again", async () => {
    // The cost of turning the setting on, stated in the docs: one full rewrite.
    const fixture = before();
    vi.stubEnv("DOCS_GEN_TOPIC_PLAN", "on");
    const first = fakeModel();
    const planned = await generate(first, fixture.sectionSynthesis);
    expect([...planned.regeneration!.changed].sort()).toEqual(
      sectionGroupsFor("business-requirements")
        .map((g) => g.id)
        .sort(),
    );
    const second = fakeModel();
    const again = await generate(second, planned.sectionSynthesis);
    expect(second.calls).toEqual([]);
    expect(again.regeneration).toEqual({ mode: "unchanged", changed: [] });
  });

  it.each(["off", "true", ""])(
    "#1119 — writing the setting as %j costs no section call: every stored section is reused",
    async (value) => {
      // The document's INPUT SNAPSHOT does change when a DOCS_GEN_* variable
      // is written to the environment (`generation-inputs.test.ts`), so one
      // run is queued. This is what that run costs: nothing is written again.
      const fixture = before();
      vi.stubEnv("DOCS_GEN_TOPIC_PLAN", value);
      const provider = fakeModel();
      const result = await generate(provider, fixture.sectionSynthesis);
      expect(provider.calls).toEqual([]);
      expect(result.regeneration).toEqual({ mode: "unchanged", changed: [] });
      expect(sha(result.markdown)).toBe(fixture.markdownSha256);
    },
  );
});

describe.skipIf(WRITING)(
  "#1119 — with citations, fact-checking and escalation, off is still what it was before #1070",
  () => {
    const before = (): GroundedFixture =>
      JSON.parse(readFileSync(GROUNDED_FIXTURE, "utf8")) as GroundedFixture;
    const groups = sectionGroupsFor("business-requirements");
    const labelsWhere = (batched: boolean): string[] =>
      groups.filter((g) => Boolean(g.batched) === batched).map((g) => g.label);
    /** The section groups a variant wrote on both models: local first, then cloud. */
    const escalatedGroups = (capture: GroundedCapture): string[] => [
      ...new Set(
        capture.calls
          .filter(
            (call) =>
              call.provider === "cloud" &&
              capture.calls.some((c) => c.provider === "local" && c.group === call.group),
          )
          .map((call) => call.group),
      ),
    ];

    it("has a fixture that reaches the grounding and the escalation code", () => {
      const { grounded, escalated } = before();
      for (const capture of [grounded, escalated]) {
        // Citations became footnotes, and their definitions take room from the body.
        expect(capture.footnoteDefinitions).toBeGreaterThan(5);
        expect(capture.footnoteDefinitionsChars).toBeGreaterThan(200);
        // The claim extractor and the judge both ran, on both models.
        for (const kind of ["claims", "judge"] as const) {
          for (const provider of ["local", "cloud"] as const) {
            expect(
              capture.chats.some((c) => c.kind === kind && c.provider === provider),
              `${kind} on ${provider}`,
            ).toBe(true);
          }
        }
        // Both caps cut.
        expect(capture.sections.filter((s) => s.omittedTopics?.length).length).toBeGreaterThan(1);
        expect(capture.markdownChars).toBeGreaterThan(25_000);
        // A note that lists twelve topics and counts the rest, and (the
        // overview, one long topic) a section shortened without losing a topic.
        expect(
          Math.max(...capture.sections.map((s) => s.omittedTopics?.length ?? 0)),
        ).toBeGreaterThan(12);
        expect(capture.sections[0].omittedTopics ?? []).toEqual([]);
        // A module read in several parts, a table and an H4 in every reply.
        expect(capture.calls.some((call) => call.moduleParts > 1)).toBe(true);
        // The module directory named `canon` is cited, as module facts.
        expect(capture.selectedEvidence.some((s) => /^facts:canon:\d+$/.test(s.sourceId))).toBe(
          true,
        );
        expect(capture.canonFootnotes).toHaveLength(1);
        expect(capture.canonFootnotes[0]).toContain("`canon` (module facts)");
      }
      // Without escalation nothing is written twice, and the sections are stored.
      expect(escalatedGroups(grounded)).toEqual([]);
      expect(grounded.sectionSynthesis!.records.map((r) => r.sectionId)).toEqual(
        groups.map((g) => g.id),
      );
      expect(grounded.warnings.length).toBeGreaterThan(0);
      const stored = grounded.sectionSynthesis!.records.map((r) => r.markdown);
      expect(stored[0]).toContain("Its remaining detail was left out.");
      expect(stored.some((markdown) => /; and \d+ more\./.test(markdown))).toBe(true);
      expect(stored.some((markdown) => markdown.includes("\n#### Limits of "))).toBe(true);
      expect(stored.some((markdown) => markdown.includes("| timeout | 30 |"))).toBe(true);
      // With it, a section written in batches and one written in a single call
      // are both written again by the cloud model, and kept.
      const again = escalatedGroups(escalated);
      expect(again.filter((label) => labelsWhere(true).includes(label)).length).toBeGreaterThan(1);
      expect(again.filter((label) => labelsWhere(false).includes(label)).length).toBeGreaterThan(0);
      expect(new Set(escalated.sections.map((s) => s.model)).size).toBe(1);
      expect(escalated.sectionSynthesis).toBeNull();
    });

    it.each(
      (["grounded", "escalated"] as const).flatMap((variant) =>
        [undefined, "off", "true"].map((value) => ({
          variant,
          value,
          setting: value === undefined ? "unset" : `\`${value}\``,
        })),
      ),
    )(
      "$variant: the same prompts, judge calls, document and evidence with the setting $setting",
      async ({ variant, value }) => {
        if (value !== undefined) vi.stubEnv("DOCS_GEN_TOPIC_PLAN", value);
        else expect(process.env.DOCS_GEN_TOPIC_PLAN).toBeUndefined();
        const now = await runGrounded(variant);
        const then = before()[variant];
        // Every section prompt, and every request to the claim extractor and
        // the judge (messages and options), byte for byte.
        expect(now.calls).toEqual(then.calls);
        expect(now.chats).toEqual(then.chats);
        // The document, footnotes included.
        expect(now.canonFootnotes).toEqual(then.canonFootnotes);
        expect(now.markdownSha256).toBe(then.markdownSha256);
        // Warnings, provenance, admitted evidence and the reuse records.
        expect(now).toEqual(then);
      },
    );

    it("reuses every fact-checked section stored before #1070", async () => {
      const { grounded } = before();
      stubVariant("grounded");
      const log: GroundedLog = { calls: [], chats: [] };
      const result = await generateGrounded(log, grounded.sectionSynthesis);
      expect(log.calls).toEqual([]);
      expect(log.chats).toEqual([]);
      expect(result.regeneration).toEqual({ mode: "unchanged", changed: [] });
      expect(sha(result.markdown)).toBe(grounded.markdownSha256);
    });
  },
);
