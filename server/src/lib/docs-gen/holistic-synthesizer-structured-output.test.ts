/**
 * #117 — end to end through the real synthesis loop: local structured-output
 * modes, and an unparseable grounding reply surfacing as a document warning.
 *
 * Run 6 (2026-09-23, `laguna-s-2.1` on Ollama, structured output off) logged
 * "Failed to parse claim decomposition as JSON, returning empty" and the section
 * got zero claims and no faithfulness check while the document stayed clean.
 * The provider double here is that runtime: prose for `json_schema` or no
 * `response_format`, JSON only for `json_object` (unless told to ignore that too).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../ai/types.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import { deriveDocStatus } from "./grounding/degraded-warnings.js";
import { DEFAULT_JUDGE_MAX_BATCH } from "./grounding/faithfulness-judge.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";

const db = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  codeGraph: { findMany: vi.fn() },
  codeSymbol: { findMany: vi.fn(), groupBy: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
vi.mock("../finops/index.js", () => ({ recordUsage: vi.fn() }));

const CLAIM = "Source facts.";
const PROSE = "- Source facts are described here.\n- Nothing else.";

const runtime: {
  honourJsonObject: boolean;
  /** When set, the judge answers prose even in json_object mode. */
  judgeAlwaysProse: boolean;
  /** When > 1, the claim list has this many claims and a 1-claim judge batch answers prose. */
  claimCount: number;
  calls: Array<{ judge: boolean; format: string }>;
} = { honourJsonObject: true, judgeAlwaysProse: false, claimCount: 1, calls: [] };

const provider = {
  key: "local-gemma",
  model: "laguna-s-2.1",
  offline: false,
  chat: vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
    const judge = String(messages[0].content).includes("strict faithfulness judge");
    const format = opts.responseFormat?.type ?? "off";
    runtime.calls.push({ judge, format });
    const json =
      format === "json_object" && runtime.honourJsonObject && !(judge && runtime.judgeAlwaysProse);
    if (!json) return { content: PROSE };
    if (runtime.claimCount > 1) {
      if (!judge) {
        const claims = Array.from({ length: runtime.claimCount }, (_, i) => ({
          claim: `Claim ${i + 1}.`,
          sourceIds: [],
        }));
        return { content: JSON.stringify({ claims }) };
      }
      // The judge prompt numbers its claims "N. text"; a lone-claim batch is prose.
      const asked = [...String(messages[1].content).matchAll(/^\d+\. (Claim \d+\.)$/gm)].map(
        (m) => m[1],
      );
      if (asked.length === 1) return { content: PROSE };
      const verdicts = asked.map((claim) => ({ claim, supported: true, sourceIds: [] }));
      return { content: JSON.stringify({ verdicts }) };
    }
    return {
      content: JSON.stringify(
        judge
          ? { verdicts: [{ claim: CLAIM, supported: true, sourceIds: [] }] }
          : { claims: [{ claim: CLAIM, sourceIds: [] }] },
      ),
    };
  }),
  async *stream(messages: Array<{ content: unknown }>): AsyncGenerator<ChatChunk> {
    const prompt = String(messages.at(-1)?.content);
    const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)?.[1] ?? "Section";
    yield { type: "delta", content: `## ${label}\n\n${CLAIM}` };
    yield { type: "done", finishReason: "stop" };
  },
} as unknown as AIProvider;

const meta = { name: "Project", language: "typescript", totalFiles: 1, totalSymbols: 3 };
const facts: ModuleFacts[] = [
  {
    modulePath: "src/orders",
    moduleName: "orders",
    classCount: 1,
    methodCount: 2,
    facts: "Validate orders.",
    formulas: [],
    topClasses: ["Order"],
  },
];
const groups = sectionGroupsFor("architecture");
const context: GroundingContext = {
  sources: [
    {
      sourceId: "rag:reference:1",
      kind: "rag",
      label: "Reference",
      text: CLAIM,
      documentId: "reference",
      chunkId: "1",
      evidenceClass: "project-reference",
    },
  ],
  sourceIds: new Set(["rag:reference:1"]),
  isEmpty: false,
};

function synth() {
  const tuning = docsGenTuning("local", "laguna-s-2.1");
  const router: Phase2Router = {
    primary: {
      kind: "local",
      provider,
      tuning,
      factsCharCap: tuning.factsCharCap,
      supportsCaching: false,
    },
    hybrid: null,
  };
  return synthesizeFinalDocument(
    facts,
    meta,
    "architecture",
    "Architecture",
    router,
    "p",
    undefined,
    undefined,
    async () => context,
  );
}

const ungrounded = (r: Awaited<ReturnType<typeof synth>>) =>
  r.warnings.filter((w) => w.kind === "section-ungrounded");

beforeEach(() => {
  runtime.honourJsonObject = true;
  runtime.judgeAlwaysProse = false;
  runtime.claimCount = 1;
  runtime.calls = [];
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("DOCS_GEN_LOCAL_REFINE", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local structured output modes through synthesis (#117)", () => {
  it("off: an unparseable claim list surfaces a grounding warning per section, not a clean doc", async () => {
    vi.stubEnv("DOCS_GEN_LOCAL_STRUCTURED_OUTPUT", "off");
    const result = await synth();
    const w = ungrounded(result);
    expect(w).toHaveLength(groups.length);
    for (const warning of w) {
      expect(warning.message).toContain("claim list could not be parsed");
      expect(warning.message).toContain("DOCS_GEN_LOCAL_STRUCTURED_OUTPUT=json_object");
      expect(warning.ratio).toBeUndefined();
    }
    expect(deriveDocStatus(result.warnings)).toBe("degraded");
  });

  it("json_schema on an accept-and-ignore runtime recovers via the json_object retry", async () => {
    vi.stubEnv("DOCS_GEN_LOCAL_STRUCTURED_OUTPUT", "json_schema");
    const result = await synth();
    expect(ungrounded(result)).toEqual([]);
    // Each grounding call went json_schema first, then json_object.
    const claimFormats = runtime.calls.filter((c) => !c.judge).map((c) => c.format);
    expect(claimFormats.slice(0, 2)).toEqual(["json_schema", "json_object"]);
    const judgeFormats = runtime.calls.filter((c) => c.judge).map((c) => c.format);
    expect(judgeFormats.slice(0, 2)).toEqual(["json_schema", "json_object"]);
  });

  it("json_object sends JSON mode from the first call, with no wasted json_schema request", async () => {
    vi.stubEnv("DOCS_GEN_LOCAL_STRUCTURED_OUTPUT", "json_object");
    const result = await synth();
    expect(ungrounded(result)).toEqual([]);
    expect(runtime.calls.length).toBeGreaterThan(0);
    expect(new Set(runtime.calls.map((c) => c.format))).toEqual(new Set(["json_object"]));
  });

  it("an unparseable verdict list surfaces a grounding warning too", async () => {
    vi.stubEnv("DOCS_GEN_LOCAL_STRUCTURED_OUTPUT", "json_object");
    runtime.judgeAlwaysProse = true;
    const result = await synth();
    const w = ungrounded(result);
    expect(w).toHaveLength(groups.length);
    for (const warning of w) expect(warning.message).toContain("verdicts could not be parsed");
  });

  it("a partly unparseable verdict set warns even when the scored claims clear the bar", async () => {
    vi.stubEnv("DOCS_GEN_LOCAL_STRUCTURED_OUTPUT", "json_object");
    // 41 claims → judge batches of 40 and 1; the lone-claim batch never parses.
    runtime.claimCount = DEFAULT_JUDGE_MAX_BATCH + 1;
    const result = await synth();
    const w = ungrounded(result);
    expect(w).toHaveLength(groups.length);
    for (const warning of w) expect(warning.message).toContain("verdicts could not be parsed");
  });
});
