/**
 * #152 — end to end through the real synthesis loop: claim extraction runs on
 * its OWN output cap, and a claim reply cut off at that cap surfaces as a
 * truncation warning — not as "ignored json_schema", and without a json_object
 * retry that cannot succeed.
 *
 * Run 7 (2026-09-23, gemma3:12b, json_schema): the Formulas section's claim
 * reply stopped at 8,192 tokens, was re-asked in json_object mode, stopped
 * again, and the document told the operator to set json_object.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../ai/types.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
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

const calls: Array<{ judge: boolean; format: string; maxTokens?: number }> = [];

const provider = {
  key: "local-gemma",
  model: "gemma3:12b",
  offline: false,
  chat: vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
    const judge = String(messages[0].content).includes("strict faithfulness judge");
    calls.push({ judge, format: opts.responseFormat?.type ?? "off", maxTokens: opts.maxTokens });
    if (judge) {
      return {
        content: JSON.stringify({ verdicts: [{ claim: CLAIM, supported: true, sourceIds: [] }] }),
        finishReason: "stop",
      };
    }
    // Every claim reply is stopped by max_tokens, JSON cut mid-array.
    return { content: '{"claims":[{"claim":"Source fa', finishReason: "length" };
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
  const tuning = docsGenTuning("local", "gemma3:12b");
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

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("DOCS_GEN_LOCAL_REFINE", "0");
  vi.stubEnv("DOCS_GEN_LOCAL_STRUCTURED_OUTPUT", "json_schema");
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "5000");
  vi.stubEnv("DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS", "3000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("claim extraction cut off at its output cap, through synthesis (#152)", () => {
  it("runs on DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS, not the section cap", async () => {
    await synth();
    const claimCalls = calls.filter((c) => !c.judge);
    expect(claimCalls.length).toBeGreaterThan(0);
    for (const c of claimCalls) expect(c.maxTokens).toBe(3000);
  });

  it("is asked once per section — no json_object retry of a cut-off reply", async () => {
    await synth();
    const claimCalls = calls.filter((c) => !c.judge);
    expect(claimCalls).toHaveLength(groups.length);
    expect(new Set(claimCalls.map((c) => c.format))).toEqual(new Set(["json_schema"]));
  });

  it("warns that the claim list exceeded its output cap, naming the claim cap", async () => {
    const result = await synth();
    const w = result.warnings.filter((x) => x.kind === "section-ungrounded");
    expect(w).toHaveLength(groups.length);
    for (const warning of w) {
      expect(warning.message).toContain("exceeded its output cap");
      expect(warning.message).toContain("DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS");
      expect(warning.message).not.toContain("json_object");
    }
  });
});
