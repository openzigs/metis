/**
 * #1070 — with `DOCS_GEN_TOPIC_PLAN` off, which is the default, a
 * business-requirements document is generated EXACTLY as it was before the
 * topic plan existed: the same prompts, the same document, the same reuse
 * inputs. So no existing BRD pays a rewrite on upgrade, and a section stored
 * before the upgrade is still reused after it.
 *
 * This is not the new code compared with itself. The fixture
 * `__fixtures__/brd-before-1070.json` was produced by the code BEFORE #1070
 * (`origin/main` at 7f8ff4c0, the commit the change is based on), by running
 * this very file there:
 *
 *   git worktree add --detach /tmp/before-1070 7f8ff4c0   # or: git archive | tar -x
 *   cp server/src/lib/docs-gen/holistic-synthesizer-topic-plan-off.test.ts \
 *      /tmp/before-1070/server/src/lib/docs-gen/
 *   cd /tmp/before-1070 && pnpm install --frozen-lockfile --prod=false \
 *      && pnpm --filter @metis/shared build && cd server \
 *      && WRITE_BEFORE_1070_FIXTURE=1 npx vitest run \
 *           src/lib/docs-gen/holistic-synthesizer-topic-plan-off.test.ts
 *
 * It imports nothing #1070 added, so it runs unchanged on both sides. The
 * scenario is one the plan WOULD change if it were on: module facts that carry
 * shared constants and a formula (a facts sheet), a model that writes three
 * times what it is asked, and section and document caps that both bind.
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

import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";
import type { ExtractedFormula } from "../code-graph/formula-extractor.js";
import type { PersistedMinedRule } from "./fact-slices.js";
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

beforeEach(() => {
  // The header carries the date.
  vi.useFakeTimers({ now: new Date("2026-01-15T12:00:00Z"), toFake: ["Date"] });
  // Two or three modules to a batch, and caps that both bind for this model.
  vi.stubEnv("DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP", "6000");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "16384");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "9000");
  vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "30000");
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
});
