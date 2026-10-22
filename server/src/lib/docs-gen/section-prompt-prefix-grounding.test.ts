/**
 * #1329 — with repository source on disk, every batch of a section is given
 * the same retrieved grounding (up to 60K characters of excerpts). DeepSeek
 * reads back only a prefix matched from token 0, so those excerpts must sit
 * AHEAD of the batch's own facts: otherwise sibling batches share only the
 * writer brief and the document lead (~11K bytes on run C's replay), and the
 * excerpts are paid for in full by every batch.
 *
 * Built through the real prompt-assembly path (`synthesizeFinalDocument`, its
 * batching and its grounding merge), with a fake model that records prompts.
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
import { buildGroundingContext, type GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";

const pad = (n: number, seed: string): string =>
  `${seed} ${"the request is validated against the configured policy and rejected otherwise ".repeat(Math.ceil(n / 80) + 1)}`.slice(
    0,
    n,
  );

function mod(name: string): ModuleFacts {
  const bullets = (kind: string, n: number) =>
    Array.from({ length: n }, (_, i) => `- ${pad(108, `${kind} ${i} of ${name}:`)}`).join("\n");
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 4,
    facts: [
      "PURPOSE",
      `${name} handles one business capability.`,
      "RULES",
      bullets("rule", 20),
      "WORKFLOWS",
      bullets("step", 12),
      "ENTITIES",
      bullets("entity", 4),
    ].join("\n"),
    formulas: [],
    topClasses: [],
  };
}

interface Call {
  section: string;
  stream: string;
}

function recordingModel(calls: Call[]): AIProvider {
  return {
    key: "anthropic",
    model: "fake-section-model",
    offline: false,
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const text = (m: ChatMessage | undefined) => String(m?.content ?? "");
      const user = text(messages[messages.length - 1]);
      const section = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      calls.push({ section, stream: `${text(messages[0])}\u0000${user}` });
      yield { type: "delta", content: `## ${section}\n\n### Topic\n\nWritten.` };
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
  } as unknown as AIProvider;
}

/** Retrieved repository excerpts, as a run with source on disk is given. */
const EXCERPT_CHARS = 2_000;
const EXCERPTS = 6;
function repositoryGrounding(): GroundingContext {
  return buildGroundingContext({
    ragChunks: Array.from({ length: EXCERPTS }, (_, i) => ({
      documentId: `doc-${i}`,
      chunkId: `chunk-${i}`,
      filename: `connector:repo:fixture:internal/file${i}.go`,
      evidenceClass: "repository-source" as const,
      text: `// excerpt ${i}\n${pad(EXCERPT_CHARS - 20, `func handle${i}() error`)}`,
    })),
  });
}

const commonPrefix = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

async function batchCalls(): Promise<{ calls: Call[]; grounding: GroundingContext }> {
  const calls: Call[] = [];
  const provider = recordingModel(calls);
  const tuning = docsGenTuning("anthropic", provider.model);
  const router: Phase2Router = {
    primary: {
      kind: "anthropic",
      provider,
      supportsCaching: true,
      factsCharCap: tuning.factsCharCap,
      tuning,
    },
    hybrid: null,
  };
  const grounding = repositoryGrounding();
  await synthesizeFinalDocument(
    Array.from({ length: 6 }, (_, i) => mod(`p${i}`)),
    { name: "Fixture", totalFiles: 60, totalSymbols: 900, language: "go" } as never,
    "business-requirements",
    "BRD",
    router,
    "p1",
    grounding,
  );
  return { calls, grounding };
}

const RULES = sectionGroupsFor("business-requirements").find((g) => g.id === "rules")!;

beforeEach(() => {
  scoreFaithfulnessMock.mockReset();
  scoreFaithfulnessMock.mockResolvedValue({
    section: "x",
    totalClaims: 1,
    supportedClaims: 1,
    faithfulness: 1,
    verified: true,
    unsupportedClaims: [],
    supportedAttributions: [],
  });
  // Small enough a cap that the six modules are written in several batches.
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_CHARS", "1000000000");
  vi.stubEnv("DOCS_GEN_DOCUMENT_MAX_CHARS", "1000000000");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sibling batches share the retrieved excerpts as a prompt prefix (#1329)", () => {
  it("every batch of a section shares a prefix that runs through all the retrieved excerpts", async () => {
    const { calls, grounding } = await batchCalls();
    const rules = calls.filter((c) => c.section === RULES.label);
    expect(rules.length).toBeGreaterThan(1);
    const excerptChars = grounding.sources.reduce((n, s) => n + s.text.length, 0);
    expect(excerptChars).toBeGreaterThan(EXCERPTS * (EXCERPT_CHARS - 100));
    const [first, ...rest] = rules;
    for (const batch of rest) {
      const shared = first.stream.slice(0, commonPrefix(first.stream, batch.stream));
      // The minimum: the excerpts alone, never mind the brief and lead before them.
      expect(shared.length).toBeGreaterThan(excerptChars);
      for (const source of grounding.sources) expect(shared).toContain(source.text);
      // ...and it stops at the batch's own facts.
      expect(shared).not.toContain("rule 0 of p");
      const factsAt = shared.indexOf("=== EXTRACTED MODULE FACTS ===");
      expect(factsAt).toBeGreaterThan(0);
      expect(shared.length - factsAt).toBeLessThan(80);
    }
  });

  it("sends each retrieved excerpt and each of the batch's facts sources exactly once", async () => {
    const { calls, grounding } = await batchCalls();
    for (const call of calls.filter((c) => c.section === RULES.label)) {
      for (const source of grounding.sources) {
        expect(call.stream.split(source.text).length - 1).toBe(1);
      }
      const modules = [...call.stream.matchAll(/^### MODULE: (\S+)/gm)].map((m) => m[1]);
      expect(modules.length).toBeGreaterThan(0);
      const factIds = [...call.stream.matchAll(/\[SOURCE id=(facts:[^\s\]]+) kind=facts/g)];
      expect(factIds).toHaveLength(modules.length);
      // The batch's facts sources follow its facts; the excerpts precede them.
      const facts = call.stream.indexOf("=== EXTRACTED MODULE FACTS ===");
      expect(call.stream.indexOf("[SOURCE id=rag:")).toBeLessThan(facts);
      expect(factIds[0].index).toBeGreaterThan(facts);
    }
  });
});
